#!/usr/bin/env python3
"""Minimal fake MPRIS player named like YouTube Music, for developing without the real app.
Usage: python3 scripts/fake_mpris.py   (needs python-dbus and python-gobject)"""
import time
import dbus, dbus.service
from dbus.mainloop.glib import DBusGMainLoop
from gi.repository import GLib

PLAYER = "org.mpris.MediaPlayer2.Player"
TRACKS = [("Fake Song One", "The Mocks", "Test Album", 200), ("Fake Song Two", "The Mocks", "Test Album", 95)]

class Fake(dbus.service.Object):
    def __init__(self, bus):
        super().__init__(bus, "/org/mpris/MediaPlayer2")
        self.i, self.status, self.pos, self.vol, self.shuffle, self.loop = 0, "Paused", 0.0, 0.8, False, "None"
        self.t = time.monotonic()
        GLib.timeout_add(250, self.tick)

    def tick(self):
        now = time.monotonic()
        if self.status == "Playing":
            self.pos += now - self.t
            if self.pos >= TRACKS[self.i][3]: self.Next()
        self.t = now
        return True

    def props(self):
        t = TRACKS[self.i]
        return {
            "PlaybackStatus": self.status, "Volume": dbus.Double(self.vol), "Shuffle": self.shuffle,
            "LoopStatus": self.loop, "Position": dbus.Int64(self.pos * 1e6),
            "CanControl": True, "CanSeek": True, "CanGoNext": True, "CanGoPrevious": True,
            "Metadata": dbus.Dictionary({
                "mpris:trackid": dbus.ObjectPath(f"/track/{self.i}"), "mpris:length": dbus.Int64(t[3] * 1e6),
                "xesam:title": t[0], "xesam:artist": dbus.Array([t[1]], signature="s"), "xesam:album": t[2],
            }, signature="sv"),
        }

    @dbus.service.method("org.freedesktop.DBus.Properties", in_signature="ss", out_signature="v")
    def Get(self, iface, name): return self.props()[name]
    @dbus.service.method("org.freedesktop.DBus.Properties", in_signature="s", out_signature="a{sv}")
    def GetAll(self, iface): return self.props()
    @dbus.service.method("org.freedesktop.DBus.Properties", in_signature="ssv")
    def Set(self, iface, name, v):
        if name == "Volume": self.vol = float(v)
        elif name == "Shuffle": self.shuffle = bool(v)
        elif name == "LoopStatus": self.loop = str(v)

    @dbus.service.method(PLAYER)
    def Play(self): self.status = "Playing"
    @dbus.service.method(PLAYER)
    def Pause(self): self.status = "Paused"
    @dbus.service.method(PLAYER)
    def PlayPause(self): self.status = "Paused" if self.status == "Playing" else "Playing"
    @dbus.service.method(PLAYER)
    def Stop(self): self.status, self.pos = "Stopped", 0.0
    @dbus.service.method(PLAYER)
    def Next(self): self.i, self.pos = (self.i + 1) % len(TRACKS), 0.0
    @dbus.service.method(PLAYER)
    def Previous(self): self.i, self.pos = (self.i - 1) % len(TRACKS), 0.0
    @dbus.service.method(PLAYER, in_signature="x")
    def Seek(self, us): self.pos = max(0.0, self.pos + us / 1e6)
    @dbus.service.method(PLAYER, in_signature="ox")
    def SetPosition(self, _id, us): self.pos = us / 1e6

DBusGMainLoop(set_as_default=True)
bus = dbus.SessionBus()
name = dbus.service.BusName("org.mpris.MediaPlayer2.youtube_music_fake", bus)
Fake(bus)
print("fake MPRIS player running; Ctrl-C to stop")
GLib.MainLoop().run()
