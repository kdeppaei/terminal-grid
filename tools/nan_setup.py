"""Drive configured NAN/NDP test-app buttons on two already authorized Android DUTs."""

import argparse
from concurrent.futures import ThreadPoolExecutor
from fnmatch import fnmatchcase
import json
from pathlib import Path
import re
import sys
import time
from uuid import uuid4
from xml.etree import ElementTree

from nan_verify import VerificationError, read_device, run_adb, serial_argument, interface_argument


PACKAGE = r"[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+"
COMPONENT = re.compile(PACKAGE + r"/\.?[A-Za-z_][A-Za-z0-9_.$]*")
ROLES = {"both": ("DUT1", "DUT2"), "dut1": ("DUT1",), "dut2": ("DUT2",)}
PROPERTIES = {"text", "resource-id", "content-desc", "text-glob"}


class SetupError(Exception):
    pass


def valid_selector(value):
    return (isinstance(value, dict) and bool(value) and value.keys() <= PROPERTIES
            and not {"text", "text-glob"} <= value.keys()
            and all(isinstance(v, str) and v.strip() and len(v) <= 256
                    and not any(ord(c) < 32 or ord(c) == 127 for c in v) for v in value.values())
            and ("text-glob" not in value or any(c.isalnum() for c in value["text-glob"])))


def load_profile(path):
    with Path(path).open("rb") as stream:
        raw = stream.read(65537)
    if len(raw) > 65536:
        raise SetupError("Profile exceeds 64 KiB.")
    profile = json.loads(raw.decode("utf-8-sig"))
    if not isinstance(profile, dict) or set(profile) != {"version", "nan", "ndp"} or type(profile["version"]) is not int or profile["version"] != 1:
        raise SetupError("Profile must contain version 1, nan and ndp.")
    for phase in ("nan", "ndp"):
        steps = profile[phase]
        if not isinstance(steps, list) or not 1 <= len(steps) <= 10:
            raise SetupError(f"{phase}: expected 1–10 steps.")
        for index, step in enumerate(steps, 1):
            error = f"{phase} step {index}: invalid action or selector."
            if not isinstance(step, dict) or step.get("target") not in ("both", "dut1", "dut2"):
                raise SetupError(error)
            if set(step) == {"target", "launch"} and isinstance(step["launch"], str) and COMPONENT.fullmatch(step["launch"]):
                continue
            if (not isinstance(step.get("package"), str) or not re.fullmatch(PACKAGE, step["package"])):
                raise SetupError(error)
            if set(step) == {"target", "package", "wait"} and valid_selector(step["wait"]):
                continue
            if (set(step) in ({"target", "package", "tap"}, {"target", "package", "tap", "unless"})
                    and valid_selector(step["tap"]) and ("unless" not in step or valid_selector(step["unless"]))):
                continue
            raise SetupError(error)
    return profile


def adb_query(adb, serial, role, command):
    result = run_adb(adb, serial, command, role)
    if result.returncode:
        raise SetupError(f"{role}: ADB failed during {command.split()[0]} (exit {result.returncode}).")
    return result.stdout


def hierarchy(adb, serial, role):
    path = "/data/local/tmp/tgrid-ui-" + uuid4().hex + ".xml"
    result = adb_query(adb, serial, role, f"uiautomator dump {path} >/dev/null && cat {path}; status=$?; rm -f {path}; exit $status")
    if "<!DOCTYPE" in result or "<!ENTITY" in result:
        raise SetupError(f"{role}: invalid UI hierarchy.")
    return ElementTree.fromstring(result.strip())


def nodes_for(tree, package, selector):
    if tree.tag != "hierarchy" or not len(tree) or any(node.get("package") != package for node in tree):
        return []
    def matches(node, key, value):
        if key == "text-glob":
            label = " ".join(node.get("text", "").split())
            return bool(label) and fnmatchcase(label, value)
        return node.get(key) == value

    return [node for node in tree.iter("node") if node.get("package") == package
            and all(matches(node, key, value) for key, value in selector.items())]


def center(node):
    bound = re.fullmatch(r"\[(\d{1,5}),(\d{1,5})\]\[(\d{1,5}),(\d{1,5})\]", node.get("bounds", ""))
    if not bound:
        return None
    left, top, right, bottom = map(int, bound.groups())
    return ((left + right) // 2, (top + bottom) // 2) if left < right and top < bottom else None


def resolve_action(adb, serial, role, step):
    deadline = time.monotonic() + 9
    package = step["package"]
    while time.monotonic() < deadline:
        try:
            tree = hierarchy(adb, serial, role)
        except (SetupError, ElementTree.ParseError):
            time.sleep(0.35)
            continue
        if "unless" in step and nodes_for(tree, package, step["unless"]):
            return None
        if "wait" in step:
            if nodes_for(tree, package, step["wait"]):
                return None
        else:
            matches = nodes_for(tree, package, step["tap"])
            if len(matches) > 1:
                raise SetupError(f"{role}: ambiguous button. Use its exact resource ID.")
            if matches:
                node = matches[0]
                parents = {child: parent for parent in tree.iter() for child in parent}
                while node is not None and node.get("package") == package and node.get("enabled") == "true":
                    if node.get("clickable") == "true":
                        point = center(node)
                        if point:
                            return point
                        break
                    node = parents.get(node)
        time.sleep(0.35)
    raise SetupError(f"{role}: expected app or control was not ready. Check the device screen and profile.")


def execute_phase(options, steps):
    devices = {"DUT1": options.dut1, "DUT2": options.dut2}
    for role, serial in devices.items():
        result = adb_query(options.adb, serial, role, "echo TGRID_DEVICE_READY").strip()
        if result != "TGRID_DEVICE_READY":
            raise SetupError(f"{role}: ADB did not confirm the selected device.")
    with ThreadPoolExecutor(max_workers=2) as pool:
        def on_devices(roles, action):
            pending = [(role, pool.submit(action, devices[role], role)) for role in roles]
            return [(role, future.result()) for role, future in pending]

        print(f"{options.phase.upper()} | waking DUT1, DUT2", flush=True)
        on_devices(devices, lambda serial, role: adb_query(options.adb, serial, role, "input keyevent KEYCODE_WAKEUP"))

        for index, step in enumerate(steps, 1):
            roles = ROLES[step["target"]]
            action = next(key for key in ("launch", "tap", "wait") if key in step)
            target = step["launch"] if action == "launch" else json.dumps(step[action], ensure_ascii=True)
            print(f"{options.phase.upper()} {index}/{len(steps)} | {', '.join(roles)} | {action} {target}", flush=True)
            if action == "launch":
                for role, result in on_devices(roles, lambda serial, role: adb_query(
                        options.adb, serial, role, "am start -W -n " + step["launch"].replace("$", r"\$"))):
                    if re.search(r"(?im)^\s*(Error(?:\s+type\s+\d+)?\b|Exception\b)", result):
                        raise SetupError(f"{role}: could not open the configured activity.")
                continue
            resolved = dict(on_devices(roles, lambda serial, role: resolve_action(options.adb, serial, role, step)))
            if action == "tap":
                # Resolve both controls before sending either click. Do not replay
                # partial actions if a device disconnects during a paired click.
                def tap(serial, role):
                    x, y = resolved[role]
                    adb_query(options.adb, serial, role, f"input tap {x} {y}")

                on_devices([role for role in roles if resolved[role]], tap)

        if options.phase == "ndp":
            deadline = time.monotonic() + 25
            while True:
                try:
                    on_devices(devices, lambda serial, role: read_device(
                        options.adb, serial, options.if1 if role == "DUT1" else options.if2, role))
                    break
                except VerificationError as error:
                    if error.code != 6 or time.monotonic() >= deadline:
                        raise
                    time.sleep(0.7)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--adb", required=True)
    parser.add_argument("--dut1", required=True, type=serial_argument)
    parser.add_argument("--dut2", required=True, type=serial_argument)
    parser.add_argument("--if1", default="auto", type=interface_argument)
    parser.add_argument("--if2", default="auto", type=interface_argument)
    parser.add_argument("--phase", required=True, choices=("nan", "ndp"))
    parser.add_argument("--profile", required=True)
    options = parser.parse_args()
    if options.dut1.casefold() == options.dut2.casefold():
        parser.error("DUT1 and DUT2 must be different.")
    try:
        profile = load_profile(options.profile)
        execute_phase(options, profile[options.phase])
    except (VerificationError, SetupError, OSError, ValueError) as error:
        print(f"NAN UI: {error}", file=sys.stderr, flush=True)
        return 1
    print(f"NAN UI: {options.phase} steps completed.", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
