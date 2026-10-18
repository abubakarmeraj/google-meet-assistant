"""Bootstrap regression tests; no downloads, elevation, auth, or user profiles."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch
from urllib.error import URLError

FILE = Path(__file__).resolve().parents[2] / "install.py"
SPEC = importlib.util.spec_from_file_location("bootstrap", FILE)
bootstrap = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bootstrap)
FINISH_SPEC = importlib.util.spec_from_file_location("finish", FILE.with_name("finish_install.py"))
finish = importlib.util.module_from_spec(FINISH_SPEC)
FINISH_SPEC.loader.exec_module(finish)


class BootstrapTests(unittest.TestCase):
    def test_node_version_floor(self):
        for version, ready in [(None, False), ("22.12.0", False), ("22.13.0", True), ("24.17.0", True), ("bad", False)]:
            with self.subTest(version=version), patch.object(bootstrap, "probe", return_value=version):
                self.assertEqual(bootstrap.node_ready(), ready)

    def test_no_installs_when_tools_exist(self):
        with patch.object(bootstrap, "node_ready", return_value=True), patch.object(bootstrap, "cpp_ready", return_value=True), \
                patch.object(bootstrap, "rust_ready", return_value=True), patch.object(bootstrap, "probe", return_value="ok"):
            self.assertEqual(bootstrap.tools_needed("docker"), [])

    def test_docker_and_wsl_prerequisites_are_separate(self):
        with patch.object(bootstrap, "node_ready", return_value=True), patch.object(bootstrap, "cpp_ready", return_value=True), \
                patch.object(bootstrap, "rust_ready", return_value=True), \
                patch.object(bootstrap, "probe", side_effect=lambda args, **kw: None if args[0] in {"docker", "gh"} else "ok"):
            self.assertEqual([t[1] for t in bootstrap.tools_needed("docker")], ["Docker.DockerDesktop"])
            self.assertEqual(bootstrap.tools_needed("wsl"), [])
            self.assertEqual(bootstrap.tools_needed("none"), [])

    def test_mac_and_linux_exit_before_windows_mutations(self):
        for system in ["darwin", "linux"]:
            with patch.object(bootstrap.sys, "platform", system), patch.object(bootstrap, "refresh_path") as refresh:
                self.assertEqual(bootstrap.main([]), 1)
                refresh.assert_not_called()

    def test_standalone_and_in_repo_destinations(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            self.assertEqual(bootstrap.destination(None, base / "download/install.py", base), (base / "Programs/GoogleMeetAssistant").resolve())
            checkout = base / "repo"
            (checkout / "scripts").mkdir(parents=True)
            (checkout / "scripts/setup-personal.mjs").touch()
            (checkout / "package.json").write_text(json.dumps({"name": "natively"}))
            self.assertEqual(bootstrap.destination(None, checkout / "install.py", base), checkout.resolve())
            with self.assertRaises(bootstrap.SetupError):
                bootstrap.destination("relative-path", base / "install.py", base)

    def test_nonempty_directory_is_preserved(self):
        with tempfile.TemporaryDirectory() as tmp:
            file = Path(tmp) / "keep.txt"
            file.write_text("unrelated data")
            runner = Mock()
            with self.assertRaises(bootstrap.SetupError):
                bootstrap.checkout(runner, Path(tmp))
            runner.run.assert_not_called()
            self.assertEqual(file.read_text(), "unrelated data")

    def test_clone_is_anonymous_preserves_paths_and_restores_environment(self):
        with tempfile.TemporaryDirectory(prefix="setup space ") as tmp:
            folder = Path(tmp) / "app & literal"
            runner = Mock()
            captured = {}
            runner.run.side_effect = lambda *args, **kwargs: captured.update({key: os.environ.get(key) for key in ["GIT_TERMINAL_PROMPT", "GCM_INTERACTIVE", "GIT_ASKPASS"]})
            with patch.object(bootstrap, "probe") as probe, patch.object(bootstrap, "is_source", side_effect=[False, True]), \
                    patch.dict(os.environ, {"GIT_TERMINAL_PROMPT": "1", "GCM_INTERACTIVE": "Auto", "GIT_ASKPASS": "old-helper"}):
                bootstrap.checkout(runner, folder)
                self.assertEqual(os.environ["GIT_TERMINAL_PROMPT"], "1")
                self.assertEqual(os.environ["GIT_ASKPASS"], "old-helper")
                probe.assert_not_called()
            args = runner.run.call_args.args[0]
            self.assertEqual(args[-1], str(folder))
            self.assertIn("credential.helper=", args)
            self.assertIn("credential.interactive=false", args)
            self.assertNotIn("gh", " ".join(args))
            self.assertEqual(captured, {"GIT_TERMINAL_PROMPT": "0", "GCM_INTERACTIVE": "Never", "GIT_ASKPASS": ""})
            self.assertEqual(runner.run.call_count, 1)
            self.assertEqual(args[-2], bootstrap.REPOSITORY)

    def test_restart_exit_is_not_reported_as_success(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(bootstrap.subprocess, "run", return_value=Mock(returncode=3010)):
            with self.assertRaises(bootstrap.RestartRequired):
                bootstrap.Runner(Path(tmp) / "log.txt").run(["fake-installer"], interactive=True)

    def test_missing_tools_install_and_revalidate(self):
        missing = [("C++ tools", "Microsoft.VisualStudio.2022.BuildTools", "--wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"),
                   ("Rust", "Rustlang.Rustup", None)]
        runner = Mock()
        with patch.object(bootstrap, "tools_needed", side_effect=[missing, []]), \
                patch.object(bootstrap.shutil, "which", return_value="winget.exe"), patch.object(bootstrap, "refresh_path"):
            bootstrap.install_tools(runner, "docker")
        calls = [call.args[0] for call in runner.run.call_args_list]
        self.assertIn("--override", calls[0])
        self.assertIn("--norestart", calls[0][-1])
        self.assertEqual(calls[-1], ["rustup", "default", "stable-x86_64-pc-windows-msvc"])
        self.assertFalse(any("Docker.DockerDesktop" in args for args in calls))

    def test_missing_winget_stops_before_mutation(self):
        runner = Mock()
        with patch.object(bootstrap, "tools_needed", return_value=[("Git", "Git.Git", None)]), \
                patch.object(bootstrap.shutil, "which", return_value=None):
            with self.assertRaises(bootstrap.SetupError):
                bootstrap.install_tools(runner, "none")
        runner.run.assert_not_called()

    def test_check_does_not_create_files_or_install(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {"LOCALAPPDATA": tmp}), \
                patch.object(bootstrap.sys, "platform", "win32"), patch.object(bootstrap.platform, "machine", return_value="AMD64"), \
                patch.object(bootstrap, "refresh_path"), patch.object(bootstrap, "tools_needed", return_value=[]), \
                patch.object(bootstrap, "install_tools") as installer:
            self.assertEqual(bootstrap.main(["--check", "--search", "none", "--directory", str(Path(tmp) / "new app")]), 0)
            installer.assert_not_called()
            self.assertEqual(list(Path(tmp).iterdir()), [])

    def test_resume_does_not_install_missing_tools(self):
        with patch.object(bootstrap, "tools_needed", return_value=[("Git", "Git.Git", None)]), \
                patch.object(bootstrap, "install_tools") as installer:
            with self.assertRaisesRegex(bootstrap.SetupError, "Resume only installs the app"):
                bootstrap.resume_tools("docker")
        installer.assert_not_called()

    def test_resume_main_skips_all_prerequisite_installation(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {"LOCALAPPDATA": tmp}), \
                patch.object(bootstrap.sys, "platform", "win32"), patch.object(bootstrap.platform, "machine", return_value="AMD64"), \
                patch.object(bootstrap, "refresh_path"), patch.object(bootstrap, "tools_needed", return_value=[]), \
                patch.object(bootstrap, "resume_tools") as resume, patch.object(bootstrap, "install_tools") as installer, \
                patch.object(bootstrap, "checkout") as checkout, patch.object(bootstrap.shutil, "which", return_value="node.exe"), \
                patch.object(bootstrap, "Runner") as runner, patch.object(bootstrap, "install_lock", return_value=bootstrap.contextlib.nullcontext()):
            folder, profile = Path(tmp) / "app", Path(tmp) / "profile"
            self.assertEqual(bootstrap.main(["--resume", "--search", "none", "--directory", str(folder), "--profile", str(profile)]), 0)
            installer.assert_not_called()
            resume.assert_called_once_with("none")
            checkout.assert_called_once_with(runner.return_value, folder)
            self.assertEqual(runner.return_value.run.call_count, 1)

    def test_clone_failure_also_restores_environment(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {"GIT_TERMINAL_PROMPT": "1"}):
            runner = Mock()
            runner.run.side_effect = bootstrap.SetupError("network error")
            with self.assertRaises(bootstrap.SetupError):
                bootstrap.checkout(runner, Path(tmp) / "app")
            self.assertEqual(os.environ["GIT_TERMINAL_PROMPT"], "1")

    @unittest.skipUnless(os.name == "nt", "Windows process and file-lock integration")
    def test_real_process_failure_and_lock_release(self):
        with tempfile.TemporaryDirectory() as tmp:
            runner = bootstrap.Runner(Path(tmp) / "log.txt")
            with self.assertRaises(bootstrap.SetupError):
                runner.run([bootstrap.sys.executable, "-c", "raise SystemExit(7)"])
            lock = Path(tmp) / "install.lock"
            with bootstrap.install_lock(lock):
                with self.assertRaises(bootstrap.SetupError):
                    with bootstrap.install_lock(lock):
                        pass
            with bootstrap.install_lock(lock):
                pass


class FinishTests(unittest.TestCase):
    def test_help_does_not_need_network(self):
        with patch.object(finish, "download_installer") as download:
            self.assertEqual(finish.main(["--help"]), 0)
            download.assert_not_called()

    def test_download_is_anonymous_and_validates_expected_installer(self):
        payload = ('REPOSITORY = ' + repr(finish.REPOSITORY) + '\n').encode()
        response = Mock(status=200)
        response.read.return_value = payload
        context = Mock()
        context.__enter__ = Mock(return_value=response)
        context.__exit__ = Mock(return_value=False)
        with tempfile.TemporaryDirectory() as tmp, patch.object(finish, "urlopen", return_value=context) as request:
            target = Path(tmp) / "install.py"
            finish.download_installer(target)
            self.assertEqual(target.read_bytes(), payload)
            self.assertIsNone(request.call_args.args[0].get_header("Authorization"))

    def test_invalid_downloads_are_never_saved_or_run(self):
        for payload in [b'<html>login</html>', b'REPOSITORY = "wrong"\n', b'x' * (finish.MAX_BYTES + 1)]:
            with self.subTest(payload=payload[:30]), tempfile.TemporaryDirectory() as tmp:
                response = Mock(status=200)
                response.read.return_value = payload
                context = Mock()
                context.__enter__ = Mock(return_value=response)
                context.__exit__ = Mock(return_value=False)
                with patch.object(finish, "urlopen", return_value=context):
                    target = Path(tmp) / "install.py"
                    with self.assertRaises((SyntaxError, RuntimeError)):
                        finish.download_installer(target)
                    self.assertFalse(target.exists())

    def test_network_failure_retries_then_stops_without_execution(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(finish, "urlopen", side_effect=URLError("offline")) as request, \
                patch.object(finish.time, "sleep"), patch.object(finish.subprocess, "run") as execute:
            with self.assertRaises(RuntimeError):
                finish.download_installer(Path(tmp) / "install.py")
            self.assertEqual(request.call_count, 3)
            execute.assert_not_called()

    def test_finish_only_runs_updated_installer_in_resume_mode(self):
        with patch.object(finish.sys, "platform", "win32"), patch.object(finish, "download_installer") as download, \
                patch.object(finish.subprocess, "run", return_value=Mock(returncode=0)) as execute:
            self.assertEqual(finish.main(["--search", "none", "--no-launch"]), 0)
            download.assert_called_once()
            command = execute.call_args.args[0]
            self.assertEqual(command[2:], ["--resume", "--search", "none", "--no-launch"])
            self.assertNotIn("gh", command)

    def test_finish_mac_branch_has_no_download_or_windows_side_effect(self):
        with patch.object(finish.sys, "platform", "darwin"), patch.object(finish, "download_installer") as download:
            self.assertEqual(finish.main([]), 1)
            download.assert_not_called()


if __name__ == "__main__":
    unittest.main()
