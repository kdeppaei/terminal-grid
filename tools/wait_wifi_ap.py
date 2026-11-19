"""Wait for the specified DUT's infrastructure Wi-Fi association state."""
import argparse
from pathlib import Path
import re
import subprocess
import sys
import time


def matches(output, state, ssid, bssid):
    lines = [line.strip() for line in output.splitlines()]
    if "Wifi is enabled" not in lines:
        return False
    if state == "disconnected":
        return "Wifi is not connected" in lines and not any(
            line.startswith("Wifi is connected to ") for line in lines
        )
    connected = [line.removeprefix("Wifi is connected to ")
                 for line in lines if line.startswith("Wifi is connected to ")]
    if connected not in ([ssid], ['"' + ssid + '"']):
        return False
    if not bssid:
        return True
    return any(re.search(r"(?i)\bBSSID:\s*" + re.escape(bssid) + r"\b", line)
               for line in lines if line.startswith("WifiInfo:"))


def open_connect_args(args):
    command = [args.adb, "-s", args.serial, "shell", "cmd", "wifi", "connect-network",
               args.ssid.encode("utf-8").hex(), args.open_security, "-x"]
    if args.bssid:
        command.extend(("-b", args.bssid))
    return command


def wait(args):
    command = [args.adb, "-s", args.serial, "shell", "cmd", "wifi", "status"]
    deadline = time.monotonic() + args.timeout
    if args.action_script:
        script = Path(args.action_script).resolve(strict=True)
        if script.suffix.lower() != ".py" or not script.is_file():
            raise ValueError("The optional local action must be a Python file.")
        subprocess.run([sys.executable, str(script), "--serial", args.serial,
                        "--state", args.state, "--ssid", args.ssid, "--bssid", args.bssid],
                       cwd=script.parent, timeout=args.timeout, check=True)
    elif args.open_security:
        result = subprocess.run(open_connect_args(args), timeout=min(8, args.timeout),
                                capture_output=True, text=True, encoding="utf-8", errors="replace", check=True)
        if re.search(r"(?i)\b(failed|error|exception|unknown command)\b", result.stdout + result.stderr):
            raise ValueError("Android did not accept the AP connection request.")
    good = 0
    while (remaining := deadline - time.monotonic()) > 0:
        try:
            result = subprocess.run(command, timeout=min(4, remaining),
                                    capture_output=True, text=True, encoding="utf-8", errors="replace")
            good = good + 1 if result.returncode == 0 and matches(
                result.stdout, args.state, args.ssid, args.bssid
            ) else 0
        except subprocess.TimeoutExpired:
            good = 0
        if good == 2:
            print("TERMINAL_GRID_AP_READY", flush=True)
            return
        time.sleep(min(0.75, max(0, deadline - time.monotonic())))
    raise TimeoutError("The target AP state could not be verified while Wi-Fi remained enabled.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--adb", default="adb")
    parser.add_argument("--serial", required=True)
    parser.add_argument("--state", choices=("connected", "disconnected"), required=True)
    parser.add_argument("--ssid", default="")
    parser.add_argument("--bssid", default="")
    parser.add_argument("--timeout", type=int, default=30)
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--action-script", help="Optional trusted local .py file that changes the AP state")
    action.add_argument("--open-security", choices=("open", "owe"), help="Connect to an approved test AP and save its network")
    args = parser.parse_args()
    if (not re.fullmatch(r"[A-Za-z0-9_.:\[\]%-]{1,128}", args.serial)
            or not 2 <= args.timeout <= 300
            or (args.state == "connected" and not (0 < len(args.ssid.encode("utf-8")) <= 32))
            or (args.open_security and args.state != "connected")
            or any(ord(char) < 32 for char in args.ssid)
            or (args.bssid and not re.fullmatch(r"(?i)([0-9a-f]{2}:){5}[0-9a-f]{2}", args.bssid))):
        parser.error("Invalid serial, AP identifier or timeout.")
    try:
        wait(args)
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print(error, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
