#!/usr/bin/env python3
"""The frog's spells: the host on Linux Wayland desktops (design/94).

Shows overlay/spells.html in a see-through layer over one screen (wlr layer
shell: Hyprland, Sway, KDE Plasma, niri, COSMIC; not GNOME). The layer takes
the pointer only where the page says (the frog and its panels): everywhere
else clicks fall through to the app below. It takes the keyboard only while
the page asks (a panel is open); otherwise it never has the focus, so the
app keeps its selection and the person keeps typing where they were.

While it has the keyboard it has all of it: no app and no desktop shortcut
gets a key. A page that kept the keys with no panel to show for them locked
the person out until they logged out. So the keys are guarded here too, not
only in the page: while they are held the page is asked every second whether
a panel still needs them (no, or no answer: they go back); a page that
crashes gives them back; and this process ends (which gives them back) when
the helper is gone or its own main loop stops answering.

The computer helper (hotkeys-device.js) drives it: JSON lines on stdin are
messages for the page (`show` also names the screen); the page's messages
come out on stdout as JSON lines. Nothing here reads or keeps the person's
text beyond passing it to the page.

Needs GTK 4, gtk4-layer-shell and WebKitGTK 6 (with their GObject
introspection data) and PyGObject. libgtk4-layer-shell must be loaded
before libwayland-client: run with LD_PRELOAD set to it (the helper does).
"""
import json
import os
import sys
import threading
import time

import gi
gi.require_version("Gtk", "4.0")
gi.require_version("Gdk", "4.0")
gi.require_version("Gtk4LayerShell", "1.0")
gi.require_version("WebKit", "6.0")
from gi.repository import Gdk, Gio, GLib, Gtk, WebKit  # noqa: E402
from gi.repository import Gtk4LayerShell as LayerShell  # noqa: E402
import cairo  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
PAGE = "file://" + os.path.join(HERE, "spells.html")


def out(msg):
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


def say(why):
    sys.stderr.write("spells host: " + why + "\n")
    sys.stderr.flush()


class Host:
    def __init__(self, app):
        self.app = app
        self.win = None
        self.view = None
        self.ready = False
        self.queue = []
        self.monitor = None
        self.visible = False
        self.system_dark = False
        self.last_theme = None
        self.portal = None
        self.unmap_timer = 0
        self.rects = []
        self.dragging = False
        self.keys = False       # whether the layer holds the keyboard now
        self.keys_timer = 0     # the watch over them, while held
        self.asked_at = 0.0     # when the page was asked and has not answered (0: not waiting)
        self.beat = time.monotonic()  # the main loop's last sign of life

    # ---- the window: a layer over one whole screen, see-through ----
    def build(self):
        win = Gtk.Window(application=self.app)
        win.set_decorated(False)
        LayerShell.init_for_window(win)
        LayerShell.set_namespace(win, "chattering-spells")
        LayerShell.set_layer(win, LayerShell.Layer.OVERLAY)
        for edge in (LayerShell.Edge.TOP, LayerShell.Edge.BOTTOM, LayerShell.Edge.LEFT, LayerShell.Edge.RIGHT):
            LayerShell.set_anchor(win, edge, True)
        # Over bars and panels too, measured from the screen's own edge.
        LayerShell.set_exclusive_zone(win, -1)
        LayerShell.set_keyboard_mode(win, LayerShell.KeyboardMode.NONE)
        css = Gtk.CssProvider()
        css.load_from_string("window, window.background { background: transparent; }")
        Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION + 1)

        manager = WebKit.UserContentManager()
        manager.register_script_message_handler("chattering", None)
        manager.connect("script-message-received::chattering", self.from_page)
        view = WebKit.WebView(user_content_manager=manager)
        view.set_background_color(Gdk.RGBA(0, 0, 0, 0))
        s = view.get_settings()
        s.set_enable_developer_extras(bool(os.environ.get("CHATTERING_SPELLS_DEVTOOLS")))
        s.set_allow_file_access_from_file_urls(True)
        s.set_enable_back_forward_navigation_gestures(False)
        s.set_javascript_can_access_clipboard(False)
        self.whole_frames(s)
        view.connect("context-menu", lambda *_: True)  # no "Reload" or "Inspect" menu
        view.connect("decide-policy", self.policy)
        view.connect("web-process-terminated", self.page_died)
        view.load_uri(PAGE)
        win.set_child(view)
        win.connect("realize", lambda *_: self.set_rects([]))
        self.win, self.view = win, view
        self.watch_color_scheme()

    # Every frame redraws the whole layer. With damage tracking (on by
    # default since WebKitGTK 2.50) WebKit tells the desktop only the parts
    # it thinks changed, and the place where an element was just removed
    # is not among them: a note gone from beside the frog stayed on the
    # screen, cut off at the frog's box (the part redrawn), and blinked as
    # the desktop's buffers took turns (seen 5 runs in 5; 0 in 4 without).
    # The cost is small: measured over a sleeping frog on a 5120x1440
    # screen, the same CPU and about 4 points more GPU busy time; and a
    # page with nothing moving draws no frames at all.
    @staticmethod
    def whole_frames(settings):
        if not hasattr(WebKit.Settings, "get_all_features"):
            return  # before 2.42: no damage tracking to turn off
        features = WebKit.Settings.get_all_features()
        for i in range(features.get_length()):
            f = features.get(i)
            if f.get_identifier() == "PropagateDamagingInformation":
                settings.set_feature_enabled(f, False)

    def policy(self, view, decision, kind):
        # The page never navigates away (a link, a drop): it stays the page.
        if kind == WebKit.PolicyDecisionType.NAVIGATION_ACTION:
            uri = decision.get_navigation_action().get_request().get_uri()
            if uri != PAGE:
                decision.ignore()
                return True
        return False

    def gdk_monitor(self, name):
        mons = Gdk.Display.get_default().get_monitors()
        for i in range(mons.get_n_items()):
            m = mons.get_item(i)
            if m.get_connector() == name:
                return m
        return mons.get_item(0) if mons.get_n_items() else None

    # A layer shown again costs about 200 ms to draw; one left up, empty and
    # see-through, costs nothing to show. So it stays up for a minute after
    # the frog leaves, taking neither pointer nor keys, then goes.
    LINGER_S = 60

    def show_on(self, name):
        if self.unmap_timer:
            GLib.source_remove(self.unmap_timer)
            self.unmap_timer = 0
        mon = self.gdk_monitor(name)
        if self.visible and mon is self.monitor:
            return
        self.release("shown again")
        if self.visible:
            self.win.set_visible(False)  # a layer moves to another screen by being mapped again
        self.monitor = mon
        if mon is not None:
            LayerShell.set_monitor(self.win, mon)
        self.win.present()
        self.visible = True
        self.set_rects([])

    def hide(self):
        if not self.visible:
            return
        self.release("hidden")
        self.set_rects([])
        if self.unmap_timer:
            GLib.source_remove(self.unmap_timer)
        self.unmap_timer = GLib.timeout_add_seconds(self.LINGER_S, self.unmap)

    def unmap(self):
        if self.unmap_timer:
            GLib.source_remove(self.unmap_timer)
        self.unmap_timer = 0
        self.release("unmapped")
        if self.visible:
            self.win.set_visible(False)
            self.visible = False
        return False

    # Where the pointer may land: only these rectangles. An empty region
    # lets every click through.
    def set_rects(self, rects):
        surface = self.win.get_surface() if self.win else None
        if surface is None:
            return
        region = cairo.Region([cairo.RectangleInt(int(r["x"]), int(r["y"]), max(1, int(r["w"])), max(1, int(r["h"]))) for r in rects])
        surface.set_input_region(region)

    # ---- the keyboard ----
    # True if it changed.
    def set_keyboard(self, on):
        on = bool(on) and self.visible
        if on == self.keys:
            return False
        self.keys = on
        LayerShell.set_keyboard_mode(self.win, LayerShell.KeyboardMode.EXCLUSIVE if on else LayerShell.KeyboardMode.NONE)
        if on:
            self.view.grab_focus()
            self.asked_at = 0.0
            if not self.keys_timer:
                self.keys_timer = GLib.timeout_add(self.KEYS_CHECK_MS, self.check_keys)
        elif self.keys_timer:
            GLib.source_remove(self.keys_timer)
            self.keys_timer = 0
        return True

    # Taken back here, not by the page: the helper and the page are told,
    # as if the page had given them back. `unmap` goes further: a layer no
    # longer on the screen has no keyboard in any desktop, whether or not
    # the mode change reached it (a hung page may draw no frame to carry it).
    def release(self, why, unmap=False):
        if self.keys:
            say("took the keyboard back: " + why)
            self.set_keyboard(False)
            out({"type": "keyboard", "on": False})
            self.to_page({"type": "released"})
        if unmap and self.visible:
            self.set_rects([])
            self.unmap()
            out({"type": "hidden"})  # gone from the screen: the helper shows it again when needed

    KEYS_CHECK_MS = 1000
    KEYS_ANSWER_S = 4

    # While the keys are held: does a panel still need them? Asked of the
    # page itself, so a page that is stuck, gone or wrong cannot keep them.
    def check_keys(self):
        if not self.keys:
            self.keys_timer = 0
            return False
        if self.asked_at:
            if time.monotonic() - self.asked_at > self.KEYS_ANSWER_S:
                self.release("the page did not answer for %d s" % self.KEYS_ANSWER_S, unmap=True)
                return False
            return True
        self.asked_at = time.monotonic()
        self.view.evaluate_javascript("!!(window.Spells && window.Spells.holdsKeys)", -1, None, None, None, self.keys_answered, None)
        return True

    def keys_answered(self, view, result, *_):
        self.asked_at = 0.0
        try:
            holds = view.evaluate_javascript_finish(result).to_boolean()
        except Exception as e:  # a page reloading, or gone
            holds, why = False, "the page could not answer (%s)" % e
        else:
            why = "no panel needs it"
        if self.keys and not holds:
            self.release(why)

    def page_died(self, view, reason):
        say("the page stopped (%s)" % reason)
        was_up = self.visible
        self.release("the page stopped", unmap=True)  # says "hidden" if it was up
        self.ready = False
        self.queue = []
        self.rects = []
        if not was_up:
            out({"type": "hidden"})  # the helper starts over: whatever was shown is gone
        view.load_uri(PAGE)

    # ---- the desktop's light or dark (the freedesktop appearance portal) ----
    def watch_color_scheme(self):
        try:
            self.portal = Gio.DBusProxy.new_for_bus_sync(Gio.BusType.SESSION, Gio.DBusProxyFlags.NONE, None,
                                                         "org.freedesktop.portal.Desktop", "/org/freedesktop/portal/desktop",
                                                         "org.freedesktop.portal.Settings", None)
            v = self.portal.call_sync("ReadOne", GLib.Variant("(ss)", ("org.freedesktop.appearance", "color-scheme")), Gio.DBusCallFlags.NONE, 2000, None)
            self.system_dark = v.unpack()[0] == 1
            self.portal.connect("g-signal", self.on_portal_signal)
        except Exception:
            settings = Gtk.Settings.get_default()
            self.system_dark = bool(settings and settings.get_property("gtk-application-prefer-dark-theme"))

    def on_portal_signal(self, proxy, sender, signal, params):
        if signal != "SettingChanged":
            return
        ns, key, value = params.unpack()
        if ns == "org.freedesktop.appearance" and key == "color-scheme":
            self.system_dark = value == 1
            self.to_page({"type": "theme", "theme": self.last_theme, "systemDark": self.system_dark})

    # ---- messages ----
    def to_page(self, msg):
        if not self.ready:
            self.queue.append(msg)
            return
        script = "window.Spells && window.Spells.receive(%s)" % json.dumps(json.dumps(msg))
        self.view.evaluate_javascript(script, -1, None, None, None, None, None)

    def from_helper(self, line):
        try:
            msg = json.loads(line)
        except ValueError:
            return False
        t = msg.get("type")
        if t == "quit":
            self.app.quit()
        elif t == "show":
            self.last_theme = msg.get("theme")
            msg["systemDark"] = self.system_dark
            self.show_on(msg.get("monitor"))
            self.to_page(msg)
        elif t == "hide":
            self.to_page(msg)
        else:
            self.to_page(msg)
        return False

    def from_page(self, manager, value):
        try:
            msg = json.loads(value.to_string())
        except ValueError:
            return
        t = msg.get("type")
        if t == "ready":
            self.ready = True
            for m in self.queue:
                self.to_page(m)
            self.queue = []
        elif t == "rects":
            self.rects = msg.get("rects") or []
            if not self.dragging:
                self.set_rects(self.rects)
            return
        elif t == "drag":
            # While the frog is dragged the whole screen takes the pointer,
            # so a quick move cannot outrun the frog's own small region.
            self.dragging = bool(msg.get("on"))
            whole = [{"x": 0, "y": 0, "w": max(1, self.win.get_width()), "h": max(1, self.win.get_height())}]
            self.set_rects(whole if self.dragging else self.rects)
            return
        elif t == "keyboard":
            if not self.set_keyboard(bool(msg.get("on"))):
                return  # no change: the helper is not told twice
        elif t == "hidden":
            self.hide()
        out(msg)


def main():
    if not LayerShell.is_supported():
        out({"type": "unsupported", "reason": "This desktop does not offer the layer shell (GNOME does not)."})
        sys.exit(3)
    app = Gtk.Application(application_id="app.rockfrog.chattering.spells", flags=Gio.ApplicationFlags.NON_UNIQUE)
    host = Host(app)

    def activate(_app):
        app.hold()  # alive while hidden
        host.build()
        out({"type": "host", "pid": os.getpid()})

    app.connect("activate", activate)

    def read_stdin():
        for line in sys.stdin:
            GLib.idle_add(host.from_helper, line)
        # The helper went away: nothing would ever tell this layer to give
        # the keys back. Quit; and if the main loop cannot, end anyway.
        GLib.idle_add(app.quit)
        time.sleep(3)
        os._exit(0)

    # A main loop that stops while the keys are held can neither give them
    # back nor be asked to: end the process, which gives them back (the
    # helper starts a new one). Only while held: a stall with no keys harms
    # no one.
    STALL_S = 8

    def heartbeat():
        host.beat = time.monotonic()
        return True

    def watch_main_loop():
        while True:
            time.sleep(1)
            if host.keys and time.monotonic() - host.beat > STALL_S:
                say("main loop stalled %d s while holding the keyboard: exiting to give it back" % STALL_S)
                os._exit(4)

    GLib.timeout_add(500, heartbeat)
    threading.Thread(target=read_stdin, daemon=True).start()
    threading.Thread(target=watch_main_loop, daemon=True).start()
    app.run([])


if __name__ == "__main__":
    main()
