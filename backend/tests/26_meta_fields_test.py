import httpx
import numpy as np
from conftest import T0, LayoutRow, MakeStock

from dtaluchs.core.settings import Settings

# Layout 2 is the older stand (its records come first) although it carries the higher id,
# as when an old stand is uploaded late.
ROWS: list[LayoutRow] = [
    ("timer_bivalence_more", 1, "analog", "Anlagenstatus", "Timer_BIV_mehr", 10.0),
    ("timer_bivalence_more", 2, "analog", "Anlagenstatus", "Timer_BIV_alt", 10.0),
    ("flow_temp", 1, "analog", "Heizkreis", "TVL", 10.0),
    ("flow_temp", 2, "analog", "Heizkreis", "TVL", 10.0),
    ("raw:analog:Test/AX", 1, "analog", "Test", "AX", 10.0),
    ("raw:analog:Test/AX", 2, "analog", "Test", "AX_alt", 10.0),
    ("raw:analog:Neu/BX", 1, "analog", "Neu", "BX", 10.0),
    ("raw:analog:Neu/BX", 2, "analog", "Alt", "BX_alt", 10.0),
]


def stock(settings: Settings, make_stock: MakeStock) -> None:
    n = 4
    cols = {r[0]: np.arange(n, dtype=np.int32) for r in ROWS}
    make_stock(
        settings.data_dir,
        ROWS,
        T0 + np.arange(n) * 60,
        np.array([2, 2, 1, 1], dtype=np.int32),
        cols,
    )


async def test_a_field_without_label_is_named_by_its_raw_name_in_the_newest_layout(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    stock(settings, make_stock)
    body = (await api_client.get("/api/meta")).json()
    fields = {f["id"]: f for f in body["fields"]}
    timer = fields["timer_bivalence_more"]
    assert timer["raw_names"] == ["Timer_BIV_mehr", "Timer_BIV_alt"]
    assert timer["label"] == {"de": "Timer_BIV_mehr", "en": "Timer_BIV_mehr"}
    assert timer["known"] is True


async def test_raw_names_have_no_duplicates_and_abbr_comes_from_the_catalog(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    stock(settings, make_stock)
    fields = {f["id"]: f for f in (await api_client.get("/api/meta")).json()["fields"]}
    assert fields["flow_temp"]["raw_names"] == ["TVL"]
    assert fields["flow_temp"]["abbr"] == "TVL"


async def test_a_raw_field_without_catalog_entry_is_named_by_the_newest_raw_name(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    stock(settings, make_stock)
    fields = {f["id"]: f for f in (await api_client.get("/api/meta")).json()["fields"]}
    raw = fields["raw:analog:Test/AX"]
    assert raw["raw_names"] == ["AX", "AX_alt"]
    assert raw["label"] == {"de": "AX", "en": "AX"}
    assert (raw["known"], raw["abbr"]) == (False, None)


async def test_group_and_name_of_a_raw_field_come_from_the_same_newest_layout(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    stock(settings, make_stock)
    fields = {f["id"]: f for f in (await api_client.get("/api/meta")).json()["fields"]}
    raw = fields["raw:analog:Neu/BX"]
    assert raw["raw_names"] == ["BX", "BX_alt"]
    assert (raw["label"]["de"], raw["group"]) == ("BX", "Neu")


TWO_LAYOUTS: list[LayoutRow] = [
    ("raw:analog:Neu/BX", 1, "analog", "Alt", "BX_eins", 10.0),
    ("raw:analog:Neu/BX", 2, "analog", "Neu", "BX_zwei", 10.0),
]


async def test_with_the_same_latest_record_the_higher_layout_id_is_the_newest(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    ts = np.array([T0, T0, T0 + 60, T0 + 60])
    cols = {"raw:analog:Neu/BX": np.arange(4, dtype=np.int32)}
    layout_ids = np.array([1, 2, 1, 2], dtype=np.int32)
    make_stock(settings.data_dir, TWO_LAYOUTS, ts, layout_ids, cols)
    body = (await api_client.get("/api/meta")).json()
    assert {f["layout_id"]: f["last_ts"] for f in body["firmware"]} == {1: T0 + 60, 2: T0 + 60}
    raw = {f["id"]: f for f in body["fields"]}["raw:analog:Neu/BX"]
    assert raw["raw_names"] == ["BX_zwei", "BX_eins"]
    assert (raw["label"]["de"], raw["group"]) == ("BX_zwei", "Neu")


async def test_a_layout_without_records_comes_after_those_with_records(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    ts = T0 + np.arange(3) * 60
    cols = {"raw:analog:Neu/BX": np.arange(3, dtype=np.int32)}
    make_stock(settings.data_dir, TWO_LAYOUTS, ts, np.ones(3, dtype=np.int32), cols)
    body = (await api_client.get("/api/meta")).json()
    assert [f["layout_id"] for f in body["firmware"]] == [1]
    assert [x["id"] for x in body["layouts"]] == [1, 2]
    raw = {f["id"]: f for f in body["fields"]}["raw:analog:Neu/BX"]
    assert raw["raw_names"] == ["BX_eins", "BX_zwei"]
    assert (raw["label"]["de"], raw["group"]) == ("BX_eins", "Alt")


async def test_a_known_field_shows_the_text_of_its_group_a_raw_field_its_category(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    """The text comes from the catalog; a raw field in the same category keeps the category name."""
    rows: list[LayoutRow] = [
        ("evaporator_suction_temp", 1, "analog", "ChD_Kae_Kreis", "Ansaug_Verdampfer", 10.0),
        ("raw:analog:ChD_Kae_Kreis/ZZ", 1, "analog", "ChD_Kae_Kreis", "ZZ", 10.0),
    ]
    cols = {r[0]: np.arange(2, dtype=np.int32) for r in rows}
    make_stock(settings.data_dir, rows, T0 + np.arange(2) * 60, np.ones(2, dtype=np.int32), cols)
    fields = {f["id"]: f for f in (await api_client.get("/api/meta")).json()["fields"]}
    known, raw = fields["evaporator_suction_temp"], fields["raw:analog:ChD_Kae_Kreis/ZZ"]
    assert (known["group"], known["group_label"]) == (
        "ChD_Kae_Kreis",
        {"de": "Kältekreis", "en": "refrigerant circuit"},
    )
    assert (raw["group"], raw["group_label"]) == (
        "ChD_Kae_Kreis",
        {"de": "ChD_Kae_Kreis", "en": "ChD_Kae_Kreis"},
    )
