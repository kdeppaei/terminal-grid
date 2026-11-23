import sys
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
from threading import Lock
from types import SimpleNamespace
from unittest.mock import patch
from xml.etree.ElementTree import fromstring

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import nan_setup


def screen(buttons, label="org.example.awarelab"):
    controls = "".join(
        f'<node package="{label}" text="{text}" enabled="true" clickable="true" bounds="[0,10][80,50]"/>'
        for text in buttons
    )
    return fromstring(f'<hierarchy><node package="{label}" enabled="true">{controls}</node></hierarchy>')


def test():
    path = Path(nan_setup.__file__).with_name("nan_setup.example.json")
    profile = nan_setup.load_profile(path)
    assert len(profile["nan"]) == 3
    assert not nan_setup.valid_selector({"x": "1"})
    assert not nan_setup.valid_selector({"text": "A\nB"})
    assert not nan_setup.valid_selector({"text": "A", "text-glob": "*A*"})
    assert not nan_setup.valid_selector({"text-glob": "*"})
    assert not nan_setup.nodes_for(screen(["Start BLE"], "org.example.other"), "org.example.awarelab", {"text": "Start BLE"})
    assert nan_setup.center(fromstring('<node bounds="[0,10][80,50]"/>')) == (40, 30)
    assert nan_setup.center(fromstring('<node bounds="[0,10][0,50]"/>')) is None

    options = SimpleNamespace(adb="test", dut1="FIXTURE_A", dut2="FIXTURE_B", phase="ndp",
                              if1="auto", if2="auto")
    commands, lock = [], Lock()

    def query(_adb, serial, role, command):
        with lock:
            commands.append((serial, role, command))
        return "TGRID_DEVICE_READY" if command.startswith("echo ") else ""

    def observe(_adb, serial, role):
        with lock:
            commands.append((serial, role, "observe"))
        return screen(["Start BLE", "Publish"] if role == "DUT1" else ["Start BLE", "Subscribe"])

    steps = profile["ndp"][:-1]
    with patch.object(nan_setup, "adb_query", query), patch.object(nan_setup, "hierarchy", observe), patch.object(nan_setup, "read_device") as check:
        nan_setup.execute_phase(options, steps)
        assert check.call_count == 2

    assert {serial for serial, _, _ in commands} == {"FIXTURE_A", "FIXTURE_B"}
    assert {role for _, role, cmd in commands[2:4] if cmd == "input keyevent KEYCODE_WAKEUP"} == {"DUT1", "DUT2"}
    assert all(cmd.startswith("am start") for _, _, cmd in commands[4:6])
    taps = [(index, role) for index, (_, role, cmd) in enumerate(commands) if cmd.startswith("input tap")]
    assert len(taps) == 4
    assert {taps[0][1], taps[1][1]} == {"DUT1", "DUT2"}
    assert [role for _, role in taps[2:]] == ["DUT1", "DUT2"]
    assert all(commands.index((serial, role, "observe")) < taps[0][0]
               for serial, role in [("FIXTURE_A", "DUT1"), ("FIXTURE_B", "DUT2")])

    commands.clear()
    with patch.object(nan_setup, "adb_query", query), patch.object(nan_setup, "hierarchy",
            side_effect=lambda _adb, _serial, role: screen(["Start BLE"] * (1 if role == "DUT1" else 2))):
        try:
            nan_setup.execute_phase(options, [steps[1]])
        except nan_setup.SetupError as error:
            assert "ambiguous" in str(error)
        else:
            raise AssertionError("Ambiguous second handset allowed the step")
    assert all(not cmd.startswith("input tap") for _, _, cmd in commands)

    with patch.object(nan_setup, "hierarchy", return_value=screen(["Stop BLE"])):
        assert nan_setup.resolve_action("test", "FIXTURE_A", "DUT1", steps[1]) is None
    guard = {"target": "both", "package": "org.example.awarelab",
             "tap": {"text-glob": "Toggle * link"}, "unless": {"text-glob": "Link ready (*)"}}
    assert nan_setup.valid_selector(guard["unless"])
    with patch.object(nan_setup, "hierarchy", return_value=screen(["Toggle data&#10;link", "Link ready (2)"])):
        assert nan_setup.resolve_action("test", "FIXTURE_A", "DUT1", guard) is None
    with patch.object(nan_setup, "hierarchy", return_value=screen(["Toggle data&#10;link"])):
        assert nan_setup.resolve_action("test", "FIXTURE_A", "DUT1", guard) == (40, 30)
    launcher_output = ("org.example.nanlab/org.example.nanlab.MainActivity\n"
                       "org.example.awarelab/.MainActivity\n")
    report = StringIO()
    with patch.object(nan_setup, "adb_query", return_value=launcher_output) as inspect_apps, \
            patch.object(nan_setup, "hierarchy", return_value=screen(["Start BLE"])) as inspect_screen, \
            redirect_stdout(report):
        nan_setup.check_device("test", "FIXTURE_A", profile)
        inspect_apps.assert_called_once()
        assert inspect_apps.call_args.args[1] == "FIXTURE_A"
        assert inspect_apps.call_args.args[3].startswith("cmd package query-activities")
        inspect_screen.assert_called_once_with("test", "FIXTURE_A", "DUT")
    assert "NDP 第 2 步" in report.getvalue()
    with patch.object(nan_setup, "adb_query", return_value="org.example.nanlab/.MainActivity"), \
            patch.object(nan_setup, "hierarchy") as inspect_screen, redirect_stdout(StringIO()):
        try:
            nan_setup.check_device("test", "FIXTURE_A", profile)
        except nan_setup.SetupError as error:
            assert "NDP" in str(error)
        else:
            raise AssertionError("Missing launcher passed")
        inspect_screen.assert_not_called()
    print("NAN UI setup: profile, foreground package, paired actions, ordered roles, idempotence and ambiguity passed.")


if __name__ == "__main__":
    test()
