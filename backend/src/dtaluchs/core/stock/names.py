"""The names in the folder of a plant (`DATA_DIR`); cheap to import, `dtaluchs.core.settings` reads them at start."""

RAW_DIR = "raw"  # the Parquet partitions, written only by the import
META_DB = "meta.duckdb"  # the import log, written only by the import
IMPORT_LOCK = "import.lock"  # held with LOCK_EX for a whole run
UPLOAD_DIR = "upload"
FETCH_DIR = "fetch"
SETTINGS_FILE = "settings.json"  # settings the user changes in the interface
VIEWS_FILE = "views.json"  # own views
SPILL_DIR = "tmp"  # below `[duckdb] temp_dir`, without it below `DATA_DIR`
