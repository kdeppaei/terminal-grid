#!/usr/bin/env python3
"""One-shot NAN address verification. Python 3.9+, standard library only.

Run on the PC which already has authorized ADB access to the two DUTs:
  python tools/nan_verify.py --adb adb --dut1 SERIAL_A --dut2 SERIAL_B
Add --ping to send two ICMPv6 packets from DUT2 to DUT1. Without it, only
interface addresses are read. Add --guided for manual APK setup prompts.
Terminal Grid uses --ping --terminal-grid and checks the final success line.

Exit codes: 0 resolved/ping reply; 2 invalid arguments; 3 ADB launch failure;
4 ADB query failure; 5 query timeout; 6 no ready Aware address;
7 ambiguous Aware interface/address; 8 ping failure; 9 ping timeout;
10 setup cancelled; 11 setup dialog unavailable.
"""

import argparse
import ipaddress
import json
import os
import re
import shutil
import subprocess
import sys


QUERY_TIMEOUT = 5
PING_TIMEOUT = 8
MAX_OUTPUT = 512 * 1024
PING_SUCCESS_LINE = "NAN_PING_OK"
AWARE_NAME = re.compile(r"aware[_-]data[0-9]+", re.IGNORECASE)
SERIAL = re.compile(r"[A-Za-z0-9_.:\[\]%-]{1,128}")
HEADING = re.compile(r"^\s*(?:\d+:\s+)?([\w.-]+)(?:@\S+)?:?\s+(?:<|flags|Link encap)")
INET6 = re.compile(r"\binet6\s+(?:addr:\s*)?([0-9a-fA-F:]+)(?:%[\w.-]+)?(?:/\d+)?(?=\s|$)")


class VerificationError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def serial_argument(value):
    if not SERIAL.fullmatch(value):
        raise argparse.ArgumentTypeError("Use a valid ADB device serial.")
    return value


def interface_argument(value):
    if value != "auto" and not AWARE_NAME.fullmatch(value):
        raise argparse.ArgumentTypeError("Use auto, aware_dataN or aware-dataN.")
    return value


def parse_addresses(output, selected="auto"):
    """Only ready link-local addresses on the selected Aware interface(s)."""
    interfaces = {}
    # Explicit-device queries may omit the heading in some tool output.
    current = None if selected == "auto" else selected
    for line in output.splitlines():
        heading = HEADING.match(line)
        if heading:
            current = heading.group(1)
        if not current or not AWARE_NAME.fullmatch(current):
            continue
        if selected != "auto" and current != selected:
            continue
        if re.search(r"\b(?:tentative|dadfailed)\b", line, re.IGNORECASE):
            continue
        match = INET6.search(line)
        if not match:
            continue
        try:
            address = ipaddress.IPv6Address(match.group(1))
        except ipaddress.AddressValueError:
            continue
        if address.is_link_local:
            interfaces.setdefault(current, set()).add(address.compressed)
    return interfaces


def choose_address(output, selected, role):
    interfaces = parse_addresses(output, selected)
    if not interfaces:
        raise VerificationError(6, f"{role}: no ready link-local IPv6 on {selected}. Establish NDP first.")
    if len(interfaces) != 1:
        names = ", ".join(sorted(interfaces))
        raise VerificationError(7, f"{role}: multiple Aware interfaces ({names}); set its --if option explicitly.")
    name, addresses = next(iter(interfaces.items()))
    if len(addresses) != 1:
        raise VerificationError(7, f"{role}: multiple ready IPv6 addresses on {name}; inspect the NDP state manually.")
    return name, next(iter(addresses))


def run_adb(adb, serial, command, role, ping=False):
    timeout = PING_TIMEOUT if ping else QUERY_TIMEOUT
    args = [adb, "-s", serial, "shell"]
    if ping:
        args.append("-T")
    args.append(command)
    try:
        result = subprocess.run(
            args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace",
            timeout=timeout, check=False, shell=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except subprocess.TimeoutExpired as error:
        raise VerificationError(9 if ping else 5, f"{role}: {'ping' if ping else 'ADB query'} timed out after {timeout}s.") from error
    except OSError as error:
        raise VerificationError(3, f"Cannot launch ADB: {error}") from error
    if len(result.stdout) + len(result.stderr) > MAX_OUTPUT:
        raise VerificationError(8 if ping else 4, f"{role}: unexpected oversized ADB output.")
    return result


def read_device(adb, serial, selected, role):
    command = "ip -6 addr show" + (" dev " + selected if selected != "auto" else "")
    result = run_adb(adb, serial, command, role)
    if result.returncode:
        message = (result.stderr + result.stdout).strip()
        # Offline/authorization failures should not cause an unnecessary retry.
        if re.search(r"offline|unauthorized|no devices|device.*not found|more than one device|cannot connect", message, re.IGNORECASE):
            raise VerificationError(4, f"{role}: ADB query failed: {message[:500]}")
        command = "ifconfig" + (" " + selected if selected != "auto" else "")
        result = run_adb(adb, serial, command, role)
        if result.returncode:
            message = (result.stderr + result.stdout).strip()
            raise VerificationError(4, f"{role}: ip/ifconfig query failed (exit {result.returncode}): {message[:500]}")
    name, address = choose_address(result.stdout, selected, role)
    return {"serial": serial, "interface": name, "ipv6": address, "query": command}


def verify(options):
    # Sequential one-shot queries; no discovery loop, polling or background task.
    dut1 = read_device(options.adb, options.dut1, options.if1, "DUT1")
    dut2 = read_device(options.adb, options.dut2, options.if2, "DUT2")
    target = dut1["ipv6"] + "%" + dut2["interface"]
    report = {"status": "addresses_resolved", "dut1": dut1, "dut2": dut2,
              "target_from_dut2": target, "ping_requested": options.ping,
              "note": "Address presence alone does not prove NAN/NDP connectivity."}
    if options.ping:
        # Bound the remote packet count/wait as well as the local ADB timeout.
        command = "ping6 -c 2 -W 2 " + target
        result = run_adb(options.adb, options.dut2, command, "DUT2", ping=True)
        evidence = (result.stdout + result.stderr).strip()
        if result.returncode or not re.search(r"\bbytes from\b", result.stdout, re.IGNORECASE):
            raise VerificationError(8, f"DUT2: ping did not confirm a reply (exit {result.returncode}). {evidence[:1500]}")
        report.update(status="ping_reply_received", ping_command=command, ping_output=evidence[:4096])
        report["note"] = "At least one ping reply was observed; no throughput, APK state or recovery test was performed."
    return report


def guide_setup(confirm, choose, dut1, dut2):
    title = "雙手機 NAN／NDP 驗證"
    devices = f"DUT1（發布）{dut1}\nDUT2（訂閱）{dut2}\n\n"

    def wait(message):
        if not confirm(title, devices + message):
            raise VerificationError(10, "已取消 NAN 設定。")

    def needs(message):
        answer = choose(title, devices + message)
        if answer is None:
            raise VerificationError(10, "已取消 NAN 設定。")
        return answer

    wait("在兩台手機開啟 NAN 設定工具，啟動 NAN 後再按「確定」。")
    if needs("這個測項需要手動設定參數嗎？"):
        wait("依測項在指定手機上完成手動設定，確認後再按「確定」。")
    if needs("這個測項需要執行額外的啟動步驟嗎？"):
        wait("在兩台手機上同步完成測項規定的啟動步驟，再按「確定」。")
    wait("兩台切到 Wi-Fi Aware 測試工具。若需以 BLE 輔助發現，先在兩台啟動 BLE，再按「確定」。")
    wait("DUT1 按 Publish，DUT2 按 Subscribe。找到測試對端後，依 APK 顯示完成 NDP 建立，再按「確定」。")


def show_setup_dialog(dut1, dut2):
    try:
        from tkinter import Tk, TclError, messagebox
    except ImportError as error:
        raise VerificationError(11, "目前的 Python 缺少 Tkinter，無法開啟引導視窗。") from error
    try:
        root = Tk()
        root.withdraw()
        try:
            def confirm(title, message):
                return messagebox.askokcancel(title, message, parent=root)

            def choose(title, message):
                return messagebox.askyesnocancel(title, message, parent=root)

            guide_setup(confirm, choose, dut1, dut2)
        finally:
            root.destroy()
    except TclError as error:
        raise VerificationError(11, f"無法開啟引導視窗：{error}") from error


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--adb", required=True, help="Approved local adb executable path, or adb from PATH.")
    parser.add_argument("--dut1", required=True, type=serial_argument, help="Receiver/server serial.")
    parser.add_argument("--dut2", required=True, type=serial_argument, help="Sender/ping client serial.")
    parser.add_argument("--if1", default="auto", type=interface_argument, help="DUT1 Aware interface (default: auto).")
    parser.add_argument("--if2", default="auto", type=interface_argument, help="DUT2 Aware interface (default: auto).")
    parser.add_argument("--ping", action="store_true", help="Also send two bounded ICMPv6 packets from DUT2.")
    parser.add_argument("--terminal-grid", action="store_true",
                        help="After a successful --ping, append the Terminal Grid success line to stdout.")
    parser.add_argument("--guided", action="store_true", help="Show manual setup and optional test-case prompts before ADB verification.")
    parser.add_argument("--exclude-suffix", action="append", default=[], type=serial_argument,
                        help="Reject device serials ending with this suffix. May be supplied multiple times.")
    options = parser.parse_args(argv)
    if options.dut1 == options.dut2:
        parser.error("DUT1 and DUT2 must be different devices.")
    if options.terminal_grid and not options.ping:
        parser.error("--terminal-grid requires --ping.")
    for suffix in options.exclude_suffix:
        if any(serial.lower().endswith(suffix.lower()) for serial in (options.dut1, options.dut2)):
            parser.error(f"Selected device matches excluded serial suffix {suffix}.")
    executable = shutil.which(options.adb)
    if not executable and os.path.isfile(options.adb):
        executable = os.path.abspath(options.adb)
    if not executable:
        print(json.dumps({"status": "error", "code": 3, "message": "ADB executable not found."}), file=sys.stderr)
        return 3
    options.adb = executable
    try:
        if options.guided:
            show_setup_dialog(options.dut1, options.dut2)
        report = verify(options)
        print(json.dumps(report, ensure_ascii=True, indent=2), flush=True)
        if options.terminal_grid and report["status"] == "ping_reply_received":
            print(PING_SUCCESS_LINE, flush=True)
        return 0
    except VerificationError as error:
        print(json.dumps({"status": "error", "code": error.code, "message": str(error)}, ensure_ascii=True), file=sys.stderr)
        return error.code


if __name__ == "__main__":
    sys.exit(main())
