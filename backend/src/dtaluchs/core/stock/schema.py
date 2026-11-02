"""The schema of `meta.duckdb` as its migration steps; readers count them, only `store.migrations` applies them."""

MIGRATIONS: tuple[str, ...] = (
    """
    CREATE TABLE imported_files (
        name VARCHAR PRIMARY KEY,
        size BIGINT NOT NULL,
        mtime_ns BIGINT NOT NULL,
        sha256 VARCHAR,
        status VARCHAR NOT NULL CHECK (status IN ('ok', 'invalid', 'error')),
        reason VARCHAR,
        version INTEGER,
        layout_id INTEGER,
        declared_records INTEGER,
        read_records INTEGER,
        new_records INTEGER,
        conflicts INTEGER,
        imported_at TIMESTAMP NOT NULL
    );
    CREATE TABLE layouts (
        id INTEGER PRIMARY KEY,
        fingerprint VARCHAR NOT NULL UNIQUE,
        version INTEGER NOT NULL,
        sub_version INTEGER NOT NULL,
        first_seen TIMESTAMP NOT NULL
    );
    CREATE TABLE layout_columns (
        layout_id INTEGER NOT NULL,
        column_name VARCHAR NOT NULL,
        field_index INTEGER NOT NULL,
        bit_pos INTEGER,
        raw_kind VARCHAR NOT NULL,
        category VARCHAR NOT NULL,
        raw_name VARCHAR NOT NULL,
        file_factor DOUBLE,
        lut VARCHAR,
        PRIMARY KEY (layout_id, column_name)
    );
    CREATE TABLE gaps (start_ts UINTEGER NOT NULL, end_ts UINTEGER NOT NULL, seconds INTEGER NOT NULL);
    CREATE TABLE import_runs (
        id INTEGER PRIMARY KEY,
        started_at TIMESTAMP NOT NULL,
        finished_at TIMESTAMP,
        files_seen INTEGER,
        files_read INTEGER,
        records_new BIGINT,
        catalog_fingerprint VARCHAR NOT NULL,
        rebuilt BOOLEAN NOT NULL
    );
    """,
    # Schema 2: files carry their source and the run that read them last; the key is
    # source and name. DuckDB cannot change a key or add NOT NULL / CHECK columns in place, so
    # both tables are rebuilt and the old rows count as path files.
    """
    CREATE TABLE imported_files_new (
        source VARCHAR NOT NULL CHECK (source IN ('path', 'upload')),
        name VARCHAR NOT NULL,
        size BIGINT NOT NULL,
        mtime_ns BIGINT NOT NULL,
        sha256 VARCHAR,
        status VARCHAR NOT NULL CHECK (status IN ('ok', 'invalid', 'error')),
        reason VARCHAR,
        version INTEGER,
        layout_id INTEGER,
        declared_records INTEGER,
        read_records INTEGER,
        new_records INTEGER,
        conflicts INTEGER,
        imported_at TIMESTAMP NOT NULL,
        run_id INTEGER,
        PRIMARY KEY (source, name)
    );
    INSERT INTO imported_files_new
        SELECT 'path', name, size, mtime_ns, sha256, status, reason, version, layout_id,
               declared_records, read_records, new_records, conflicts, imported_at, NULL
        FROM imported_files;
    DROP TABLE imported_files;
    ALTER TABLE imported_files_new RENAME TO imported_files;
    CREATE TABLE import_runs_new (
        id INTEGER PRIMARY KEY,
        started_at TIMESTAMP NOT NULL,
        finished_at TIMESTAMP,
        files_seen INTEGER,
        files_read INTEGER,
        records_new BIGINT,
        catalog_fingerprint VARCHAR NOT NULL,
        rebuilt BOOLEAN NOT NULL,
        trigger VARCHAR NOT NULL DEFAULT 'cli',
        error VARCHAR
    );
    INSERT INTO import_runs_new
        SELECT id, started_at, finished_at, files_seen, files_read, records_new,
               catalog_fingerprint, rebuilt, 'cli', NULL
        FROM import_runs;
    DROP TABLE import_runs;
    ALTER TABLE import_runs_new RENAME TO import_runs;
    """,
    # Schema 3: the texts of a state field per layout and column; NULL where the file
    # lists none. The catalog fingerprint ignores them, so the last run gets a fingerprint no
    # catalog has: the next import rebuilds and reads the lists (a database without a run has
    # nothing to rebuild).
    """
    ALTER TABLE layout_columns ADD COLUMN options VARCHAR[];
    UPDATE import_runs SET catalog_fingerprint = 'schema-3'
        WHERE id = (SELECT max(id) FROM import_runs);
    """,
    # Schema 4: third source `fetch` and the removal date of a file under `fetch/`; the
    # result of a fetch per run. `imported_files` is rebuilt as in schema 2 (DuckDB cannot change a
    # CHECK in place). No new fingerprint: nothing is rebuilt.
    """
    CREATE TABLE imported_files_new (
        source VARCHAR NOT NULL CHECK (source IN ('path', 'upload', 'fetch')),
        name VARCHAR NOT NULL,
        size BIGINT NOT NULL,
        mtime_ns BIGINT NOT NULL,
        sha256 VARCHAR,
        status VARCHAR NOT NULL CHECK (status IN ('ok', 'invalid', 'error')),
        reason VARCHAR,
        version INTEGER,
        layout_id INTEGER,
        declared_records INTEGER,
        read_records INTEGER,
        new_records INTEGER,
        conflicts INTEGER,
        imported_at TIMESTAMP NOT NULL,
        run_id INTEGER,
        removed_at TIMESTAMP,
        PRIMARY KEY (source, name)
    );
    INSERT INTO imported_files_new
        SELECT source, name, size, mtime_ns, sha256, status, reason, version, layout_id,
               declared_records, read_records, new_records, conflicts, imported_at, run_id, NULL
        FROM imported_files;
    DROP TABLE imported_files;
    ALTER TABLE imported_files_new RENAME TO imported_files;
    ALTER TABLE import_runs ADD COLUMN fetch_result VARCHAR;
    ALTER TABLE import_runs ADD COLUMN fetch_name VARCHAR;
    ALTER TABLE import_runs ADD COLUMN fetch_path VARCHAR;
    ALTER TABLE import_runs ADD COLUMN fetch_last_ts UINTEGER;
    ALTER TABLE import_runs ADD COLUMN fetch_error VARCHAR;
    """,
)

SCHEMA_VERSION = len(MIGRATIONS)
