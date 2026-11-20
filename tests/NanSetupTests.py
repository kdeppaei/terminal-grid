import sys
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
    print("NAN UI setup: profile, foreground package, paired actions, ordered roles, idempotence and ambiguity passed.")


if __name__ == "__main__":
    test()
