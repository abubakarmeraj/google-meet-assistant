//! A meeting app's own window contents, read through the OS accessibility
//! layer, for naming who speaks in a call (electron/services/meetingDetection/
//! desktopCallSpeakers.ts). Read-only: nothing here clicks, focuses, changes a
//! setting in the app or asks for a permission.
//!
//! `read_call_tree(pid, options)`: the app's windows, each flattened to a list
//! of nodes in tree order (depth, role, the texts a screen reader would speak).
//! Which node is a participant tile and which says "speaking" is decided in JS
//! per app (callTreeSolvers.ts): the apps change their trees between releases,
//! and JS is where a recorded tree can be replayed as a test fixture.
//!   macOS   — AXUIElement (ApplicationServices). Needs the Accessibility
//!             permission, which Natively already asks for (stealth typing) and
//!             never asks for here: untrusted, the read returns `trusted: false`
//!             and no windows. One AXUIElementCopyMultipleAttributeValues per
//!             node, each with a short messaging timeout so a hung app can't
//!             hold the worker.
//!   Windows — UI Automation: the top-level windows of the pid, each fetched in
//!             one cross-process call (a cache request over the subtree), with
//!             connection and transaction timeouts. No permission involved.
//!             UNVERIFIED: compile-checked only; never run against Zoom.exe or
//!             ms-teams.exe.
//!
//! Runs on a libuv worker (AsyncTask), never on the JS thread and never near
//! the audio threads. Bounded three ways: nodes, depth and wall time; whatever
//! a bound cuts off is reported as `truncated`.

use napi::bindgen_prelude::*;
use napi::Task;
use std::time::{Duration, Instant};

#[napi(object)]
#[derive(Clone, Debug, PartialEq)]
pub struct CallTreeNode {
    /// 0 for a window's root.
    pub depth: u32,
    /// macOS AXRole (with ":" + AXSubrole when there is one); Windows the
    /// control type's name ("ListItem", "Button", …).
    pub role: String,
    /// macOS AXTitle; Windows Name.
    pub name: String,
    /// macOS AXDescription; Windows HelpText.
    pub description: String,
    /// macOS AXValue (strings only); Windows ItemStatus.
    pub value: String,
    /// macOS AXIdentifier, else AXDOMIdentifier (a web view's element id);
    /// Windows AutomationId (a WebView2 element's DOM id).
    pub id: String,
    /// A link's address: macOS AXURL; Windows a Hyperlink's Value. Empty for
    /// everything else. Read so a meeting's join link can be recognised.
    pub url: String,
}

#[napi(object)]
pub struct CallTreeWindow {
    pub title: String,
    pub nodes: Vec<CallTreeNode>,
}

#[napi(object)]
pub struct CallTree {
    /// macOS: the Accessibility permission is granted. Windows: always true.
    pub trusted: bool,
    /// A bound (nodes, depth, time) cut the walk short.
    pub truncated: bool,
    pub windows: Vec<CallTreeWindow>,
    pub elapsed_ms: u32,
}

#[napi(object)]
pub struct CallTreeOptions {
    pub max_nodes: Option<u32>,
    pub max_depth: Option<u32>,
    pub budget_ms: Option<u32>,
    pub max_windows: Option<u32>,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct Limits {
    pub max_nodes: usize,
    pub max_depth: u32,
    pub budget: Duration,
    pub max_windows: usize,
}

impl Limits {
    fn from_options(o: Option<CallTreeOptions>) -> Limits {
        let o = o.unwrap_or(CallTreeOptions { max_nodes: None, max_depth: None, budget_ms: None, max_windows: None });
        Limits {
            max_nodes: o.max_nodes.unwrap_or(2_500).clamp(1, 10_000) as usize,
            max_depth: o.max_depth.unwrap_or(40).clamp(1, 80),
            budget: Duration::from_millis(o.budget_ms.unwrap_or(250).clamp(10, 2_000) as u64),
            max_windows: o.max_windows.unwrap_or(6).clamp(1, 20) as usize,
        }
    }
}

/// One node's texts, as read from the OS.
#[derive(Default, Debug, Clone)]
pub(crate) struct NodeText {
    pub role: String,
    pub name: String,
    pub description: String,
    pub value: String,
    pub id: String,
    pub url: String,
}

/// A tree the walk can read: the OS's (AX, UIA) or a test's.
pub(crate) trait TreeSource {
    type Node;
    /// The node's texts and its children, in one read where the OS allows.
    fn visit(&mut self, node: &Self::Node, want_children: bool) -> (NodeText, Vec<Self::Node>);
}

const MAX_TEXT: usize = 200;

/// Control characters out, whitespace collapsed, at most MAX_TEXT characters.
pub(crate) fn clean_text(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len().min(MAX_TEXT));
    let mut count = 0usize;
    let mut space = false;
    for ch in raw.chars() {
        let ch = if ch.is_control() || ch.is_whitespace() { ' ' } else { ch };
        if ch == ' ' {
            if out.is_empty() || space {
                continue;
            }
            space = true;
        } else {
            space = false;
        }
        if count >= MAX_TEXT {
            break;
        }
        out.push(ch);
        count += 1;
    }
    out.trim_end().to_string()
}

const MAX_URL: usize = 600;

/// A link's address, kept only when it is http(s) and short enough to be a
/// join link; anything else (a file:// path, a data: blob) is dropped.
pub(crate) fn clean_url(raw: &str) -> String {
    let url = raw.trim();
    if url.len() > MAX_URL || url.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return String::new();
    }
    let lower = url.get(..8).unwrap_or(url).to_ascii_lowercase();
    if lower.starts_with("https://") || lower.starts_with("http://") {
        url.to_string()
    } else {
        String::new()
    }
}

/// Walks `root` depth first, in tree order, into `out`. Empty leaves (no text,
/// no children) are left out; containers stay, so the depths still say which
/// tile a label belongs to. Returns true when a bound cut the walk short.
pub(crate) fn flatten<S: TreeSource>(
    src: &mut S,
    root: S::Node,
    limits: &Limits,
    deadline: Instant,
    remaining: &mut usize,
    out: &mut Vec<CallTreeNode>,
) -> bool {
    let mut truncated = false;
    // Children are pushed reversed so they pop in order.
    let mut stack: Vec<(S::Node, u32)> = vec![(root, 0)];
    while let Some((node, depth)) = stack.pop() {
        if *remaining == 0 || Instant::now() >= deadline {
            return true;
        }
        let want_children = depth < limits.max_depth;
        let (text, children) = src.visit(&node, want_children);
        if !want_children {
            truncated = true;
        }
        let text = NodeText {
            role: clean_text(&text.role),
            name: clean_text(&text.name),
            description: clean_text(&text.description),
            value: clean_text(&text.value),
            id: clean_text(&text.id),
            url: clean_url(&text.url),
        };
        let has_text = !(text.name.is_empty() && text.description.is_empty() && text.value.is_empty());
        if has_text || !children.is_empty() || depth == 0 {
            *remaining -= 1;
            out.push(CallTreeNode {
                depth,
                role: text.role,
                name: text.name,
                description: text.description,
                value: text.value,
                id: text.id,
                url: text.url,
            });
        }
        if want_children {
            for child in children.into_iter().rev() {
                stack.push((child, depth + 1));
            }
        }
    }
    truncated
}

pub struct ReadCallTreeTask {
    pid: i32,
    limits: Limits,
}

impl Task for ReadCallTreeTask {
    type Output = Option<CallTree>;
    type JsValue = Option<CallTree>;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let started = Instant::now();
        let tree = imp::read(self.pid, &self.limits, started + self.limits.budget);
        Ok(tree.map(|mut t| {
            t.elapsed_ms = started.elapsed().as_millis().min(u32::MAX as u128) as u32;
            t
        }))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

/// The app's windows as flattened accessibility trees; null where this OS has
/// no reader or the pid is not a running app. Resolves on a worker thread.
#[napi(ts_return_type = "Promise<CallTree | null>")]
pub fn read_call_tree(pid: i32, options: Option<CallTreeOptions>) -> AsyncTask<ReadCallTreeTask> {
    AsyncTask::new(ReadCallTreeTask { pid, limits: Limits::from_options(options) })
}

#[cfg(target_os = "macos")]
mod imp {
    use super::{flatten, CallTree, CallTreeWindow, Limits, NodeText, TreeSource};
    use core_foundation::array::{CFArray, CFArrayRef};
    use core_foundation::base::{CFGetTypeID, CFType, CFTypeID, CFTypeRef, TCFType};
    use core_foundation::string::{CFString, CFStringRef};
    use core_foundation::url::CFURL;
    use std::ffi::c_void;
    use std::time::Instant;

    type AXUIElementRef = *const c_void;

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> bool;
        fn AXUIElementCreateApplication(pid: i32) -> AXUIElementRef;
        fn AXUIElementCopyAttributeValue(element: AXUIElementRef, attribute: CFStringRef, value: *mut CFTypeRef) -> i32;
        fn AXUIElementCopyMultipleAttributeValues(
            element: AXUIElementRef,
            attributes: CFArrayRef,
            options: u32,
            values: *mut CFArrayRef,
        ) -> i32;
        fn AXUIElementSetMessagingTimeout(element: AXUIElementRef, timeout_seconds: f32) -> i32;
        fn AXUIElementGetTypeID() -> CFTypeID;
    }

    /// Per message, so one unresponsive app costs at most this per node and the
    /// walk's own deadline ends it.
    const MESSAGE_TIMEOUT_S: f32 = 0.2;

    /// Owned (retained) element; CFType releases it on drop.
    struct Element(CFType);

    impl Element {
        fn raw(&self) -> AXUIElementRef {
            self.0.as_CFTypeRef() as AXUIElementRef
        }
    }

    struct Ax {
        attrs: CFArray<CFString>,
        element_type: CFTypeID,
    }

    fn string_of(value: &CFType) -> String {
        value.downcast::<CFString>().map(|s| s.to_string()).unwrap_or_default()
    }

    /// AXURL is a CFURL (some web views hand back a string instead).
    fn url_of(value: &CFType) -> String {
        if let Some(url) = value.downcast::<CFURL>() {
            return url.get_string().to_string();
        }
        string_of(value)
    }

    fn elements_of(value: &CFType, element_type: CFTypeID) -> Vec<Element> {
        let Some(array) = value.downcast::<CFArray<*const c_void>>() else { return Vec::new() };
        let mut out = Vec::with_capacity(array.len() as usize);
        for item in array.iter() {
            let ptr = *item as CFTypeRef;
            // SAFETY: the array holds CF objects alive while `array` is; we retain
            // the ones we keep (get rule) and check each is an AXUIElement first.
            if !ptr.is_null() && unsafe { CFGetTypeID(ptr) } == element_type {
                out.push(Element(unsafe { CFType::wrap_under_get_rule(ptr) }));
            }
        }
        out
    }

    impl TreeSource for Ax {
        type Node = Element;
        fn visit(&mut self, node: &Element, want_children: bool) -> (NodeText, Vec<Element>) {
            let mut values: CFArrayRef = std::ptr::null();
            // SAFETY: a live element and attribute array; on success `values` is a
            // +1 CFArray we take ownership of below.
            let err = unsafe {
                AXUIElementSetMessagingTimeout(node.raw(), MESSAGE_TIMEOUT_S);
                AXUIElementCopyMultipleAttributeValues(node.raw(), self.attrs.as_concrete_TypeRef(), 0, &mut values)
            };
            if err != 0 || values.is_null() {
                return (NodeText::default(), Vec::new());
            }
            let values: CFArray<CFType> = unsafe { CFArray::wrap_under_create_rule(values) };
            let get = |i: isize| values.get(i).map(|v| (*v).clone());
            let role = get(0).map(|v| string_of(&v)).unwrap_or_default();
            let subrole = get(1).map(|v| string_of(&v)).unwrap_or_default();
            let ax_id = get(5).map(|v| string_of(&v)).unwrap_or_default();
            let text = NodeText {
                role: if subrole.is_empty() { role } else { format!("{}:{}", role, subrole) },
                name: get(2).map(|v| string_of(&v)).unwrap_or_default(),
                description: get(3).map(|v| string_of(&v)).unwrap_or_default(),
                value: get(4).map(|v| string_of(&v)).unwrap_or_default(),
                // A web view (Teams' WKWebView, Chrome) names its elements by DOM id.
                id: if ax_id.is_empty() { get(7).map(|v| string_of(&v)).unwrap_or_default() } else { ax_id },
                url: get(8).map(|v| url_of(&v)).unwrap_or_default(),
            };
            let children = if want_children {
                get(6).map(|v| elements_of(&v, self.element_type)).unwrap_or_default()
            } else {
                Vec::new()
            };
            (text, children)
        }
    }

    fn copy_attribute(element: &Element, name: &str) -> Option<CFType> {
        let attr = CFString::new(name);
        let mut value: CFTypeRef = std::ptr::null();
        // SAFETY: a live element; on success `value` is +1 and owned below.
        let err = unsafe {
            AXUIElementSetMessagingTimeout(element.raw(), MESSAGE_TIMEOUT_S);
            AXUIElementCopyAttributeValue(element.raw(), attr.as_concrete_TypeRef(), &mut value)
        };
        (err == 0 && !value.is_null()).then(|| unsafe { CFType::wrap_under_create_rule(value) })
    }

    pub fn read(pid: i32, limits: &Limits, deadline: Instant) -> Option<CallTree> {
        if pid <= 0 {
            return None;
        }
        // SAFETY: a plain query; never prompts.
        if !unsafe { AXIsProcessTrusted() } {
            return Some(CallTree { trusted: false, truncated: false, windows: Vec::new(), elapsed_ms: 0 });
        }
        // SAFETY: returns a +1 element (or null) for the pid.
        let app = unsafe { AXUIElementCreateApplication(pid) };
        if app.is_null() {
            return None;
        }
        let app = Element(unsafe { CFType::wrap_under_create_rule(app as CFTypeRef) });
        let element_type = unsafe { AXUIElementGetTypeID() };
        let windows = copy_attribute(&app, "AXWindows").map(|v| elements_of(&v, element_type)).unwrap_or_default();
        // Indices are read in Ax::visit: keep the order.
        let names = [
            "AXRole", "AXSubrole", "AXTitle", "AXDescription", "AXValue", "AXIdentifier", "AXChildren", "AXDOMIdentifier", "AXURL",
        ];
        let attrs = CFArray::from_CFTypes(&names.iter().map(|n| CFString::new(n)).collect::<Vec<_>>());
        let mut ax = Ax { attrs, element_type };
        let mut remaining = limits.max_nodes;
        let mut truncated = windows.len() > limits.max_windows;
        let mut out = Vec::new();
        for window in windows.into_iter().take(limits.max_windows) {
            let title = copy_attribute(&window, "AXTitle").map(|v| super::clean_text(&string_of(&v))).unwrap_or_default();
            let mut nodes = Vec::new();
            truncated |= flatten(&mut ax, window, limits, deadline, &mut remaining, &mut nodes);
            out.push(CallTreeWindow { title, nodes });
            if remaining == 0 || Instant::now() >= deadline {
                truncated = true;
                break;
            }
        }
        Some(CallTree { trusted: true, truncated, windows: out, elapsed_ms: 0 })
    }
}

#[cfg(target_os = "windows")]
mod imp {
    // UNVERIFIED (2026-10-15): compile-checked with `cargo check --target
    // x86_64-pc-windows-msvc`, never executed. Zoom.exe (Qt) and ms-teams.exe
    // (WebView2) must be read on a real Windows machine before this is trusted.
    use super::{flatten, CallTree, CallTreeWindow, Limits, NodeText, TreeSource};
    use std::time::Instant;
    use windows::Win32::Foundation::{BOOL, HWND, LPARAM};
    use windows::Win32::System::Variant::{VariantClear, VT_BSTR};
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};
    use windows::Win32::UI::Accessibility::{
        CUIAutomation, IUIAutomation, IUIAutomation2, IUIAutomationCacheRequest, IUIAutomationElement, TreeScope_Subtree,
        UIA_AutomationIdPropertyId, UIA_ControlTypePropertyId, UIA_HelpTextPropertyId, UIA_ItemStatusPropertyId,
        UIA_NamePropertyId, UIA_ValueValuePropertyId,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible,
    };
    use windows::core::ComInterface;

    /// UIA's control type ids (UIA_*ControlTypeId, 50000…) by name.
    fn control_type_name(id: u32) -> &'static str {
        match id {
            50000 => "Button",
            50001 => "Calendar",
            50002 => "CheckBox",
            50003 => "ComboBox",
            50004 => "Edit",
            50005 => "Hyperlink",
            50006 => "Image",
            50007 => "ListItem",
            50008 => "List",
            50009 => "Menu",
            50010 => "MenuBar",
            50011 => "MenuItem",
            50012 => "ProgressBar",
            50013 => "RadioButton",
            50014 => "ScrollBar",
            50015 => "Slider",
            50016 => "Spinner",
            50017 => "StatusBar",
            50018 => "Tab",
            50019 => "TabItem",
            50020 => "Text",
            50021 => "ToolBar",
            50022 => "ToolTip",
            50023 => "Tree",
            50024 => "TreeItem",
            50025 => "Custom",
            50026 => "Group",
            50027 => "Thumb",
            50028 => "DataGrid",
            50029 => "DataItem",
            50030 => "Document",
            50031 => "SplitButton",
            50032 => "Window",
            50033 => "Pane",
            50034 => "Header",
            50035 => "HeaderItem",
            50036 => "Table",
            50037 => "TitleBar",
            50038 => "Separator",
            50039 => "SemanticZoom",
            50040 => "AppBar",
            _ => "",
        }
    }

    struct Uia;

    impl TreeSource for Uia {
        type Node = IUIAutomationElement;
        fn visit(&mut self, node: &IUIAutomationElement, want_children: bool) -> (NodeText, Vec<IUIAutomationElement>) {
            // SAFETY: cached reads on an element built with the cache request
            // below; no cross-process call happens here.
            unsafe {
                let role = node.CachedControlType().map(|t| control_type_name(t.0).to_string()).unwrap_or_default();
                // Only a link's Value is read: an edit field's Value is what
                // someone is typing, which is none of this reader's business.
                let url = if role == "Hyperlink" { cached_string(node, UIA_ValueValuePropertyId) } else { String::new() };
                let text = NodeText {
                    role,
                    name: node.CachedName().map(|s| s.to_string()).unwrap_or_default(),
                    description: node.CachedHelpText().map(|s| s.to_string()).unwrap_or_default(),
                    value: node.CachedItemStatus().map(|s| s.to_string()).unwrap_or_default(),
                    id: node.CachedAutomationId().map(|s| s.to_string()).unwrap_or_default(),
                    url,
                };
                let mut children = Vec::new();
                if want_children {
                    if let Ok(array) = node.GetCachedChildren() {
                        let len = array.Length().unwrap_or(0);
                        for i in 0..len {
                            if let Ok(child) = array.GetElement(i) {
                                children.push(child);
                            }
                        }
                    }
                }
                (text, children)
            }
        }
    }

    /// A cached property that holds a string (VT_BSTR); empty otherwise.
    unsafe fn cached_string(node: &IUIAutomationElement, prop: windows::Win32::UI::Accessibility::UIA_PROPERTY_ID) -> String {
        let Ok(mut variant) = node.GetCachedPropertyValue(prop) else { return String::new() };
        let inner = &variant.Anonymous.Anonymous;
        let out = if inner.vt == VT_BSTR { (*inner.Anonymous.bstrVal).to_string() } else { String::new() };
        let _ = VariantClear(&mut variant);
        out
    }

    struct Found {
        pid: u32,
        windows: Vec<(HWND, String)>,
    }

    unsafe extern "system" fn visit_window(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let found = &mut *(lparam.0 as *mut Found);
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid != found.pid || !IsWindowVisible(hwnd).as_bool() {
            return BOOL(1);
        }
        let len = GetWindowTextLengthW(hwnd);
        let mut buf = vec![0u16; len.max(0) as usize + 1];
        let n = GetWindowTextW(hwnd, &mut buf);
        found.windows.push((hwnd, String::from_utf16_lossy(&buf[..n.max(0) as usize])));
        BOOL(1)
    }

    fn cache_request(uia: &IUIAutomation) -> windows::core::Result<IUIAutomationCacheRequest> {
        // SAFETY: plain COM calls on a live IUIAutomation.
        unsafe {
            let request = uia.CreateCacheRequest()?;
            for prop in [
                UIA_NamePropertyId,
                UIA_ControlTypePropertyId,
                UIA_AutomationIdPropertyId,
                UIA_HelpTextPropertyId,
                UIA_ItemStatusPropertyId,
                UIA_ValueValuePropertyId,
            ] {
                request.AddProperty(prop)?;
            }
            request.SetTreeScope(TreeScope_Subtree)?;
            request.SetTreeFilter(&uia.ControlViewCondition()?)?;
            Ok(request)
        }
    }

    pub fn read(pid: i32, limits: &Limits, deadline: Instant) -> Option<CallTree> {
        if pid <= 0 {
            return None;
        }
        // SAFETY: COM on this worker thread (MTA, as UIA clients should be). An
        // RPC_E_CHANGED_MODE result means the thread already has COM; either way
        // the calls below work, and the thread is the pool's, so COM stays up.
        let uia: IUIAutomation = unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).ok()?
        };
        if let Ok(uia2) = uia.cast::<IUIAutomation2>() {
            // SAFETY: plain setters; a hung app can't hold the worker past them.
            unsafe {
                let _ = uia2.SetConnectionTimeout(1_000);
                let _ = uia2.SetTransactionTimeout(1_000);
            }
        }
        let request = cache_request(&uia).ok()?;
        let mut found = Found { pid: pid as u32, windows: Vec::new() };
        // SAFETY: `found` outlives the synchronous EnumWindows call.
        unsafe {
            let _ = EnumWindows(Some(visit_window), LPARAM(&mut found as *mut Found as isize));
        }
        let mut truncated = found.windows.len() > limits.max_windows;
        let mut remaining = limits.max_nodes;
        let mut out = Vec::new();
        let mut source = Uia;
        for (hwnd, title) in found.windows.into_iter().take(limits.max_windows) {
            // SAFETY: one cross-process fetch of the window's subtree into the cache.
            let root = unsafe { uia.ElementFromHandleBuildCache(hwnd, &request) };
            let Ok(root) = root else { continue };
            let mut nodes = Vec::new();
            truncated |= flatten(&mut source, root, limits, deadline, &mut remaining, &mut nodes);
            out.push(CallTreeWindow { title: super::clean_text(&title), nodes });
            if remaining == 0 || Instant::now() >= deadline {
                truncated = true;
                break;
            }
        }
        Some(CallTree { trusted: true, truncated, windows: out, elapsed_ms: 0 })
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod imp {
    use super::{CallTree, Limits};
    use std::time::Instant;
    pub fn read(_pid: i32, _limits: &Limits, _deadline: Instant) -> Option<CallTree> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A test tree: node i has `kids[i]` and `texts[i]`.
    struct Fake {
        texts: Vec<(&'static str, &'static str)>,
        kids: Vec<Vec<usize>>,
        visits: usize,
    }

    impl TreeSource for Fake {
        type Node = usize;
        fn visit(&mut self, node: &usize, want_children: bool) -> (NodeText, Vec<usize>) {
            self.visits += 1;
            let (role, name) = self.texts[*node];
            let text = NodeText { role: role.into(), name: name.into(), ..Default::default() };
            (text, if want_children { self.kids[*node].clone() } else { Vec::new() })
        }
    }

    fn tile_tree() -> Fake {
        // window → [gallery → [tile A → [label "Ana"], tile B → [label "Bo, speaking"]], empty leaf]
        Fake {
            texts: vec![
                ("AXWindow", "Zoom Meeting"),
                ("AXGroup", ""),
                ("AXGroup", ""),
                ("AXStaticText", "Ana"),
                ("AXGroup", ""),
                ("AXStaticText", "Bo, speaking"),
                ("AXImage", ""),
            ],
            kids: vec![vec![1, 6], vec![2, 4], vec![3], vec![], vec![5], vec![], vec![]],
            visits: 0,
        }
    }

    fn limits(max_nodes: usize, max_depth: u32) -> Limits {
        Limits { max_nodes, max_depth, budget: Duration::from_secs(5), max_windows: 6 }
    }

    #[test]
    fn walks_in_tree_order_with_depths_and_drops_empty_leaves() {
        let mut src = tile_tree();
        let mut out = Vec::new();
        let mut remaining = 100;
        let truncated = flatten(&mut src, 0, &limits(100, 40), Instant::now() + Duration::from_secs(5), &mut remaining, &mut out);
        assert!(!truncated);
        let got: Vec<(u32, &str)> = out.iter().map(|n| (n.depth, n.name.as_str())).collect();
        assert_eq!(got, vec![(0, "Zoom Meeting"), (1, ""), (2, ""), (3, "Ana"), (2, ""), (3, "Bo, speaking")]);
        assert_eq!(remaining, 94);
    }

    #[test]
    fn node_and_depth_bounds_truncate() {
        let mut out = Vec::new();
        let mut remaining = 3;
        assert!(flatten(&mut tile_tree(), 0, &limits(3, 40), Instant::now() + Duration::from_secs(5), &mut remaining, &mut out));
        assert_eq!(out.len(), 3);

        let mut out = Vec::new();
        let mut remaining = 100;
        let mut src = tile_tree();
        assert!(flatten(&mut src, 0, &limits(100, 1), Instant::now() + Duration::from_secs(5), &mut remaining, &mut out));
        assert!(out.iter().all(|n| n.depth <= 1));
    }

    #[test]
    fn a_passed_deadline_reads_nothing() {
        let mut out = Vec::new();
        let mut remaining = 100;
        let mut src = tile_tree();
        assert!(flatten(&mut src, 0, &limits(100, 40), Instant::now() - Duration::from_millis(1), &mut remaining, &mut out));
        assert!(out.is_empty());
        assert_eq!(src.visits, 0);
    }

    #[test]
    fn text_is_cleaned_and_bounded() {
        assert_eq!(clean_text("  Ana\n\tLopez \u{0}(Host) "), "Ana Lopez (Host)");
        assert_eq!(clean_text(&"é".repeat(500)).chars().count(), MAX_TEXT);
        assert_eq!(clean_text(""), "");
    }

    #[test]
    fn only_web_links_are_kept_as_urls() {
        assert_eq!(clean_url(" https://us02web.zoom.us/j/81234567890?pwd=x "), "https://us02web.zoom.us/j/81234567890?pwd=x");
        assert_eq!(clean_url("HTTP://teams.microsoft.com/meet/241342539466"), "HTTP://teams.microsoft.com/meet/241342539466");
        assert_eq!(clean_url("file:///Users/me/notes.txt"), "");
        assert_eq!(clean_url("https://a b"), "");
        assert_eq!(clean_url(&format!("https://x.com/{}", "a".repeat(700))), "");
        assert_eq!(clean_url(""), "");
    }

    #[test]
    fn options_are_clamped() {
        let l = Limits::from_options(Some(CallTreeOptions { max_nodes: Some(0), max_depth: Some(500), budget_ms: Some(1), max_windows: None }));
        assert_eq!((l.max_nodes, l.max_depth, l.budget, l.max_windows), (1, 80, Duration::from_millis(10), 6));
        let d = Limits::from_options(None);
        assert_eq!((d.max_nodes, d.max_depth, d.budget.as_millis()), (2_500, 40, 250));
    }
}
