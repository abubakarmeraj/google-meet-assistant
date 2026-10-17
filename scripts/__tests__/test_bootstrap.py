"""Bootstrap regression tests; no downloads, elevation, auth, or user profiles."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

FILE = Path(__file__).resolve().parents[2] / "install.py"
SPEC = importlib.util.spec_from_file_location("bootstrap", FILE)
bootstrap = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bootstrap)


class BootstrapTests(unittest.TestCase):
    def test_node_version_floor(self):
        for version, ready in [(None, False), ("22.12.0", False), ("22.13.0", True), ("24.17.0", True), ("bad", False)]:
            with self.subTest(version=version), patch.object(bootstrap, "probe", return_value=version):
                self.assertEqual(bootstrap.node_ready(), ready)

    def test_no_installs_when_tools_exist(self):
        with patch.object(bootstrap, "node_ready", return_value=True), patch.object(bootstrap, "cpp_ready", return_value=True), \
                patch.object(bootstrap, "rust_ready", return_value=True), patch.object(bootstrap, "probe", return_value="ok"):
            self.assertEqual(bootstrap.tools_needed("docker", True), [])

    def test_docker_and_wsl_prerequisites_are_separate(self):
        with patch.object(bootstrap, "node_ready", return_value=True), patch.object(bootstrap, "cpp_ready", return_value=True), \
                patch.object(bootstrap, "rust_ready", return_value=True), \
                patch.object(bootstrap, "probe", side_effect=lambda args, **kw: None if args[0] in {"docker", "gh"} else "ok"):
            self.assertEqual([t[1] for t in bootstrap.tools_needed("docker", True)], ["GitHub.cli", "Docker.DockerDesktop"])
            self.assertEqual(bootstrap.tools_needed("wsl", False), [])
            self.assertEqual(bootstrap.tools_needed("none", False), [])

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

    def test_clone_passes_literal_paths_and_uses_scoped_auth(self):
        with tempfile.TemporaryDirectory(prefix="setup space ") as tmp:
            folder = Path(tmp) / "app & literal"
            runner = Mock()
            with patch.object(bootstrap, "probe", return_value=""), patch.object(bootstrap, "is_source", side_effect=[False, True]):
                bootstrap.checkout(runner, folder)
            args = runner.run.call_args.args[0]
            self.assertEqual(args[-1], str(folder))
            self.assertIn("credential.helper=!gh auth git-credential", args)
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
            bootstrap.install_tools(runner, "docker", True)
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
                bootstrap.install_tools(runner, "none", False)
        runner.run.assert_not_called()

    def test_check_does_not_create_files_or_install(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {"LOCALAPPDATA": tmp}), \
                patch.object(bootstrap.sys, "platform", "win32"), patch.object(bootstrap.platform, "machine", return_value="AMD64"), \
                patch.object(bootstrap, "refresh_path"), patch.object(bootstrap, "tools_needed", return_value=[]), \
                patch.object(bootstrap, "install_tools") as installer:
            self.assertEqual(bootstrap.main(["--check", "--search", "none", "--directory", str(Path(tmp) / "new app")]), 0)
            installer.assert_not_called()
            self.assertEqual(list(Path(tmp).iterdir()), [])

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


if __name__ == "__main__":
    unittest.main()
