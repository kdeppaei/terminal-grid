from pathlib import Path
from types import SimpleNamespace
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
from wait_wifi_ap import matches, open_connect_args

connected = 'Wifi is enabled\nWifi is connected to "Lab A"\nWifiInfo: SSID: "Lab A", BSSID: 02:00:00:00:00:01\n'
assert matches(connected, "connected", "Lab A", "02:00:00:00:00:01")
assert not matches(connected, "connected", "Lab", "")
assert not matches(connected, "connected", "Lab A", "02:00:00:00:00:02")
assert not matches(connected, "disconnected", "", "")
assert matches("Wifi is enabled\nWifi is not connected", "disconnected", "", "")
assert not matches("Wifi is disabled", "disconnected", "", "")
assert not matches("error: device offline", "disconnected", "", "")
args = SimpleNamespace(adb="adb", serial="DUT1", ssid="Lab AP", open_security="owe", bssid="02:00:00:00:00:01")
assert open_connect_args(args)[-5:] == ["4c6162204150", "owe", "-x", "-b", args.bssid]
print("Wi-Fi AP state: SSID, BSSID, disconnected with radio on, and failures passed.")
