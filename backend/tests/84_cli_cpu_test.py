import subprocess
import sys
from pathlib import Path

import pytest

from dtaluchs import cli
from dtaluchs.cli import NUMPY_CPU, SERVE_CPU, cpu_problem, main

# Like kvm64 on the VM with HA OS: of the checked sets only cx16 was there; the other flags are base flags
KVM64 = (
    "fpu de pse tsc msr pae mce cx8 apic sep mtrr pge mca cmov pat pse36 clflush mmx fxsr sse "
    "sse2 syscall nx lm pni cx16 x2apic hypervisor lahf_lm"
)
# VM with HA OS, CPU type host on an Intel i3-N305, measured 2026-10-26
HOST = (
    "fpu vme de pse tsc msr pae mce cx8 apic sep mtrr pge mca cmov pat pse36 clflush mmx fxsr "
    "sse sse2 ss ht syscall nx pdpe1gb rdtscp lm arch_perfmon rep_good nopl xtopology cpuid "
    "tsc_known_freq pni pclmulqdq vmx ssse3 fma cx16 pdcm pcid sse4_1 sse4_2 x2apic movbe "
    "popcnt tsc_deadline_timer aes xsave avx f16c rdrand hypervisor lahf_lm abm 3dnowprefetch "
    "cpuid_fault ssbd ibrs ibpb stibp ibrs_enhanced tpr_shadow flexpriority ept vpid ept_ad "
    "fsgsbase tsc_adjust bmi1 avx2 smep bmi2 erms invpcid rdseed adx smap clflushopt clwb "
    "sha_ni xsaveopt xsavec xgetbv1 xsaves avx_vnni arat vnmi umip pku ospke waitpkg gfni vaes "
    "vpclmulqdq rdpid movdiri movdir64b fsrm md_clear serialize ibt flush_l1d arch_capabilities"
)
# amd64 container under Rosetta, measured 2026-10-26: no abm (LZCNT)
ROSETTA = (
    "fpu tsc de cx8 apic sep cmov pat pse36 clflush mmx fxsr sse sse2 syscall nx lm rep_good "
    "nopl pni cpuid pclmulqdq ssse3 cx16 sse4_1 popcnt sse4_2 aes lahf_lm movbe fma avx f16c "
    "rdrand bmi1 avx2 bmi2"
)


def cpuinfo(tmp_path: Path, flags: str | None) -> Path:
    path = tmp_path / "cpuinfo"
    lines = ["processor\t: 0", "model name\t: Common KVM processor"]
    if flags is not None:
        lines.append(f"flags\t\t: {flags}")
    path.write_text("\n".join(lines * 2) + "\n")
    return path


def test_kvm64_names_what_is_missing(tmp_path: Path) -> None:
    text = cpu_problem(SERVE_CPU, cpuinfo(tmp_path, KVM64), "x86_64")
    assert text == (
        "Die CPU hat nicht alle Befehlssätze, die dtaluchs braucht: es fehlen ssse3, sse4.1, sse4.2, popcnt, "
        "avx, avx2, fma, bmi1, bmi2, pclmulqdq, movbe. In einer VM den CPU-Typ host wählen."
    )


@pytest.mark.parametrize("flags", [HOST, ROSETTA])
def test_a_cpu_with_avx2_passes(tmp_path: Path, flags: str) -> None:
    assert cpu_problem(SERVE_CPU, cpuinfo(tmp_path, flags), "x86_64") is None


def test_only_avx2_missing(tmp_path: Path) -> None:
    text = cpu_problem(SERVE_CPU, cpuinfo(tmp_path, HOST.replace(" avx2", "")), "x86_64")
    assert text is not None
    assert "es fehlen avx2." in text


def test_x86_64_v2_without_avx_is_enough_for_numpy(tmp_path: Path) -> None:
    """Proxmox x86-64-v2-AES: NumPy runs, Polars would not."""
    v2 = "fpu sse sse2 pni pclmulqdq ssse3 cx16 sse4_1 sse4_2 popcnt aes lahf_lm"
    assert cpu_problem(NUMPY_CPU, cpuinfo(tmp_path, v2), "x86_64") is None
    text = cpu_problem(SERVE_CPU, cpuinfo(tmp_path, v2), "x86_64")
    assert text is not None
    assert "es fehlen avx, avx2, fma, bmi1, bmi2, movbe." in text


def test_kvm64_lacks_what_numpy_needs(tmp_path: Path) -> None:
    text = cpu_problem(NUMPY_CPU, cpuinfo(tmp_path, KVM64), "x86_64")
    assert text is not None
    assert "es fehlen ssse3, sse4.1, sse4.2, popcnt." in text


def test_no_flags_line_or_no_file_means_no_check(tmp_path: Path) -> None:
    assert cpu_problem(SERVE_CPU, cpuinfo(tmp_path, None), "x86_64") is None
    assert cpu_problem(SERVE_CPU, tmp_path / "missing", "x86_64") is None


@pytest.mark.parametrize("machine", ["arm64", "aarch64", "AMD64"])
def test_other_architectures_are_not_checked(tmp_path: Path, machine: str) -> None:
    assert cpu_problem(SERVE_CPU, cpuinfo(tmp_path, KVM64), machine) is None


@pytest.mark.parametrize(
    ("command", "required"),
    [(["serve"], SERVE_CPU), (["import"], NUMPY_CPU), (["fetch"], NUMPY_CPU)],
)
def test_main_stops_with_code_2_before_the_settings(
    command: list[str],
    required: dict[str, str],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    asked: list[dict[str, str]] = []

    def problem(sets: dict[str, str]) -> str:
        asked.append(sets)
        return "Die CPU hat nicht alle Befehlssätze"

    monkeypatch.setattr(cli, "cpu_problem", problem)
    monkeypatch.setattr(cli, "Settings", lambda: pytest.fail("Settings read despite the CPU"))
    monkeypatch.setenv("DATA_DIR", str(tmp_path))

    assert main(command) == 2

    assert capsys.readouterr().err == "Die CPU hat nicht alle Befehlssätze\n"
    assert asked == [required]


def test_a_configuration_error_goes_to_stderr_with_code_2(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(cli, "cpu_problem", lambda sets: None)
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setenv("PORT", "99999")

    assert main(["import"]) == 2

    seen = capsys.readouterr()
    assert "PORT" in seen.err
    assert seen.out == ""


def test_the_cli_loads_no_numpy_before_the_check() -> None:
    """The check runs before NumPy is loaded, so the module level of `dtaluchs.cli` must not load it."""
    code = "import sys, dtaluchs.cli; print('numpy' in sys.modules, 'duckdb' in sys.modules)"
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=True)
    assert out.stdout.strip() == "False False"
