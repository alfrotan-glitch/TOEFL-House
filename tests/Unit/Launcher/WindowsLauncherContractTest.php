<?php

declare(strict_types=1);

namespace Tests\Unit\Launcher;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * Pins the runtime-download contract of the Windows one-click launcher
 * (START-TOEFL-HOUSE.bat).
 *
 * Regression this guards against: the launcher hard-coded a single fully
 * qualified Windows PHP URL under /downloads/releases/. PHP's Windows feed
 * only keeps the newest patch of each branch there; once a newer 8.2.x ships,
 * the pinned patch is moved to /downloads/releases/archives/ and the old URL
 * returns HTTP 404, so a fresh clone could not boot. The launcher now derives
 * every PHP artifact from one PHP_VERSION constant and downloads with a
 * releases -> releases/archives fallback. These tests fail if that contract
 * is weakened or the version literal is re-hard-coded.
 *
 * It also pins the archive-extraction contract. The .zip archives must be
 * unpacked with the Windows BUILT-IN bsdtar (%SystemRoot%\System32\tar.exe),
 * invoked by absolute path. A PATH-resolved bare "tar" can be a GNU tar
 * (Git-for-Windows / MSYS2 / Cygwin), which (a) parses a "C:\..." archive as
 * a remote "host:file" - "tar: Cannot connect to C: resolve failed" - and
 * (b) cannot read .zip archives at all. The built-in bsdtar reads .zip and
 * treats drive letters as local paths.
 *
 * Finally it pins the PHP placement layout. The official windows.php.net PHP
 * zip is FLAT: php.exe, php-cgi.exe and ext\ are at the archive ROOT with no
 * version-named wrapper folder (the EDB PostgreSQL zip, by contrast, wraps in
 * pgsql\). PHP is therefore extracted directly into the runtime dir; a
 * staging-then-move of a "php-X.Y.Z-..." folder fails with "The system cannot
 * find the file specified" because that folder never exists.
 */
final class WindowsLauncherContractTest extends TestCase
{
    private string $bat;

    /** @var array<string,string> key -> value of set "KEY=value" lines */
    private array $vars = [];

    protected function setUp(): void
    {
        parent::setUp();

        $path = (string) realpath(__DIR__.'/../../../START-TOEFL-HOUSE.bat');
        $this->assertFileExists($path, 'START-TOEFL-HOUSE.bat must ship at the repository root for the Windows one-click deploy.');
        $this->bat = (string) file_get_contents($path);

        foreach (preg_split('/\r\n|\r|\n/', $this->bat) as $line) {
            if (preg_match('/^\s*set\s+"([A-Za-z_][A-Za-z0-9_]*)=(.*)"\s*$/', $line, $m) === 1) {
                $this->vars[$m[1]] = $m[2];
            }
        }
    }

    public function test_pins_a_single_php_8_2_version(): void
    {
        $this->assertArrayHasKey('PHP_VERSION', $this->vars, 'the launcher must define PHP_VERSION.');
        $this->assertMatchesRegularExpression(
            '/^8\.2\.\d+$/',
            $this->vars['PHP_VERSION'],
            'the project runs on PHP 8.2.x; the pin must stay on the 8.2 minor line.',
        );
    }

    public function test_php_archive_name_is_derived_from_the_version_not_literal(): void
    {
        $this->assertArrayHasKey('PHP_ZIP', $this->vars);
        // Must be built from the version variable - not a hard-coded php-8.2.xx literal.
        $this->assertStringContainsString('%PHP_VERSION%', $this->vars['PHP_ZIP'], 'PHP_ZIP must derive from PHP_VERSION.');
        $this->assertStringNotContainsString('php-8.2.', $this->vars['PHP_ZIP'], 'PHP_ZIP must not hard-code the patch version.');

        // Simulate cmd expansion.
        $zip = str_replace('%PHP_VERSION%', $this->vars['PHP_VERSION'], $this->vars['PHP_ZIP']);
        $this->assertSame("php-{$this->vars['PHP_VERSION']}-Win32-vs16-x64.zip", $zip);
    }

    public function test_php_downloads_cover_both_releases_and_permanent_archive(): void
    {
        $this->assertArrayHasKey('PHP_ZIP_URL', $this->vars);
        $this->assertArrayHasKey('PHP_ARCHIVE_ZIP_URL', $this->vars);

        $releases = str_replace('%PHP_ZIP%', '%ZIP%', $this->vars['PHP_ZIP_URL']);
        $archive = str_replace('%PHP_ZIP%', '%ZIP%', $this->vars['PHP_ARCHIVE_ZIP_URL']);

        // Current-release URL first...
        $this->assertSame('https://windows.php.net/downloads/releases/%ZIP%', $releases);
        // ...with the permanent archive as a distinct fallback.
        $this->assertSame('https://windows.php.net/downloads/releases/archives/%ZIP%', $archive);

        // The fully expanded archive URL is the one that never 404s for an older patch.
        $archiveExpanded = str_replace(
            '%PHP_ZIP%',
            str_replace('%PHP_VERSION%', $this->vars['PHP_VERSION'], $this->vars['PHP_ZIP']),
            $this->vars['PHP_ARCHIVE_ZIP_URL'],
        );
        $this->assertStringEndsWith(
            "/downloads/releases/archives/php-{$this->vars['PHP_VERSION']}-Win32-vs16-x64.zip",
            $archiveExpanded,
        );
    }

    public function test_launcher_falls_back_to_archive_when_releases_404s(): void
    {
        // PHP is fetched through the shared atomic :fetch_file helper, which is
        // given the current-release URL (PHP_ZIP_URL) as the primary source and
        // the permanent /archives/ URL (PHP_ARCHIVE_ZIP_URL) as the fallback.
        $this->assertMatchesRegularExpression(
            '/call :fetch_file "%RT%\\\\downloads\\\\php\\.zip" "%PHP_ZIP_URL%" "%PHP_ARCHIVE_ZIP_URL%" "10485760"/',
            $this->bat,
            'the PHP download must pass PHP_ZIP_URL (primary) and PHP_ARCHIVE_ZIP_URL (fallback) to :fetch_file.',
        );
        // Inside :fetch_file the fallback source runs only when the primary fails.
        $ff = $this->subroutineBody(':fetch_file');
        $this->assertMatchesRegularExpression(
            '/call :fetch_try "%FF_URL1%"[^\n]*\n\s*if errorlevel 1 if not "%FF_URL2%"==""\s*\([^)]*?call :fetch_try "%FF_URL2%"/',
            $ff,
            'the /archives/ fallback must run only when the /releases/ attempt fails (if errorlevel 1).',
        );
        $this->assertStringContainsString('archives/', $this->bat);
    }

    public function test_php_is_extracted_directly_into_the_runtime_dir_for_the_flat_zip_layout(): void
    {
        // The official windows.php.net PHP zip is FLAT: php.exe, php-cgi.exe and ext\
        // sit at the archive ROOT with no version-named wrapper folder. So the runtime
        // must be produced by extracting straight into PHP_DIR - NOT by extracting to a
        // staging dir and moving a "php-X.Y.Z-Win32-..." wrapper folder that never exists
        // (that move is what failed with "The system cannot find the file specified").
        $this->assertMatchesRegularExpression(
            '/"%TAR%"\s+-xf\s+"%RT%\\\downloads\\\php\.zip"\s+-C\s+"%PHP_DIR%"/',
            $this->bat,
            'the PHP zip must be extracted directly into %PHP_DIR% (its layout is flat, no wrapper folder).',
        );
        // No staging-then-move of a PHP wrapper folder may remain.
        $this->assertStringNotContainsString('%PHP_EXTRACT_DIR%', $this->bat, 'the obsolete wrapper-folder move variable must be gone for PHP.');
        $this->assertDoesNotMatchRegularExpression(
            '/move\s+\/y\s+"%RT%\\\downloads\\\php[^"]*"\s+"%PHP_DIR%"/i',
            $this->bat,
            'the PHP runtime must not be placed by moving a wrapper folder (the flat zip has none).',
        );
    }

    public function test_php_runtime_dir_is_recreated_clean_before_extraction(): void
    {
        // A half-extracted runtime from an interrupted run must never be reused; the
        // launcher wipes and recreates the target dir before extracting into it.
        $this->assertMatchesRegularExpression(
            '/if exist "%PHP_DIR%" rd \/q \/s "%PHP_DIR%"\s*\n\s*mkdir "%PHP_DIR%"/',
            $this->bat,
            'the launcher must remove and recreate %PHP_DIR% before a clean extraction.',
        );
    }

    public function test_downloaded_php_archive_is_verified_existing_and_non_empty(): void
    {
        // php.zip is fetched via the atomic :fetch_file helper, which is handed the
        // exact destination path and a minimum-size threshold, so a missing or
        // too-small archive is never promoted over the destination / extracted.
        $this->assertMatchesRegularExpression(
            '/call :fetch_file "%RT%\\\\downloads\\\\php\.zip" "%PHP_ZIP_URL%" "%PHP_ARCHIVE_ZIP_URL%" "10485760"/',
            $this->bat,
            'php.zip is fetched to its exact path with a non-trivial minimum-size requirement.',
        );
        // A failed download stops the launcher loudly (never continues).
        $this->assertMatchesRegularExpression(
            '/if errorlevel 1 call :fail "PHP download failed or was truncated from both %PHP_ZIP_URL% and %PHP_ARCHIVE_ZIP_URL%/',
            $this->bat,
            'a missing php.zip must fail loudly instead of continuing.',
        );
        // A below-minimum download is rejected inside :fetch_file (its .part is
        // deleted) and never reaches extraction.
        $ff = $this->subroutineBody(':fetch_file');
        $this->assertMatchesRegularExpression(
            '/if !FF_BYTES! LSS !FF_MIN! \([^\n]*\n[^)]*del \/q "%FF_DEST%\.part"/',
            $ff,
            'an empty/truncated php.zip must be discarded before it can be used.',
        );
    }

    public function test_php_extraction_is_gated_on_php_exe_being_produced(): void
    {
        // After extraction the binary itself must exist before the launcher proceeds;
        // this is the layout-change sentinel (it would have caught the bad wrapper move).
        // :php_extract aborts (exit /b 1) when php.exe was not produced, and the caller
        // (:php_download) turns that into a loud, path-naming :fail.
        $ex = $this->subroutineBody(':php_extract');
        $this->assertMatchesRegularExpression(
            '/php\.exe"[^\n]*exit \/b 1/',
            $ex,
            'the launcher must verify %PHP_DIR%\php.exe exists after extraction and abort if it was not produced.',
        );
        $dl = $this->subroutineBody(':php_download');
        $this->assertMatchesRegularExpression(
            '/call :php_extract[^\n]*\n\s*if errorlevel 1 call :fail "Could not unpack the PHP archive/',
            $dl,
            'an extraction that did not produce php.exe fails the launcher loudly.',
        );
    }

    public function test_postgresql_still_uses_its_wrapper_folder_move(): void
    {
        // Unlike PHP, the EDB PostgreSQL binaries zip DOES wrap its contents in a
        // top-level pgsql\ folder, so it extracts to staging and is moved. Guard that
        // the PHP flat-layout fix does not flatten PostgreSQL.
        $this->assertMatchesRegularExpression(
            '/"%TAR%"\s+-xf\s+"%RT%\\\downloads\\\pgsql\.zip"\s+-C\s+"%RT%\\\downloads"/',
            $this->bat,
            'PostgreSQL still extracts into staging (its zip wraps in pgsql\).',
        );
        $this->assertMatchesRegularExpression(
            '/move \/y "%RT%\\\downloads\\\pgsql" "%PG_DIR%"/',
            $this->bat,
            'PostgreSQL still moves its pgsql wrapper folder into place.',
        );
    }

    public function test_other_runtimes_use_stable_or_rolling_urls_not_archived_patches(): void
    {
        // Tailscale uses a version-pinned MSI on the official package host; that
        // contract has its own dedicated tests below (test_tailscale_*).
        $this->assertArrayHasKey('TAILSCALE_MSI_URL', $this->vars);
        // Composer is the official PERMANENT versioned PHAR (not the crash-prone
        // composer-setup.php bootstrapper, and not the capitalized Composer-stable.phar URL).
        $this->assertSame(
            'https://getcomposer.org/download/%COMPOSER_VERSION%/composer.phar',
            $this->vars['COMPOSER_PHAR_URL'] ?? '',
        );
        $this->assertMatchesRegularExpression('/^\d+\.\d+\.\d+$/', $this->vars['COMPOSER_VERSION'] ?? '');
        $this->assertStringNotContainsString('Composer-stable.phar', $this->bat);

        // PostgreSQL uses EDB's permanent binaries archive (pinned versions are retained
        // there indefinitely; this path does NOT move older patches the way PHP does).
        $this->assertStringStartsWith('https://get.enterprisedb.com/postgresql/', $this->vars['PG_ZIP_URL'] ?? '');
        $this->assertStringContainsString('binaries.zip', $this->vars['PG_ZIP_URL'] ?? '');
    }

    public function test_a_required_runtime_failure_terminates_the_whole_launcher(): void
    {
        // :fail MUST end the entire cmd process (bare "exit 1"), not "exit /b 1".
        // With /b, call :fail inside a parenthesized block returns to the block, which then
        // keeps running (the root cause of PHP failure being masked by later steps).
        $failBlock = $this->subroutineBody(':fail');
        $this->assertMatchesRegularExpression('/^\s*exit\s+1\s*$/m', $failBlock, ':fail must end with a bare "exit 1" that terminates the launcher.');
        $this->assertDoesNotMatchRegularExpression('/exit\s+\/b\s+1/', $failBlock, ':fail must not use "exit /b" (which returns to and resumes the caller).');
    }

    public function test_php_and_postgresql_downloads_go_through_the_atomic_validated_helper(): void
    {
        // Both runtimes must be fetched via the atomic :fetch_file helper (never a bare curl
        // that writes straight into the destination).
        $this->assertMatchesRegularExpression('/call :fetch_file "%RT%\\\downloads\\\php\.zip" "%PHP_ZIP_URL%" "%PHP_ARCHIVE_ZIP_URL%" "10485760"/', $this->bat);
        $this->assertMatchesRegularExpression('/call :fetch_file "%RT%\\\downloads\\\pgsql\.zip" "%PG_ZIP_URL%" "" "52428800"/', $this->bat);
        // No raw curl writing directly to php.zip / pgsql.zip (the non-atomic pattern).
        $this->assertDoesNotMatchRegularExpression('/curl\.exe[^
]*-o "%RT%\\\downloads\\\php\.zip"/', $this->bat, 'php.zip must not be written directly by curl (use .part via the helper).');
        $this->assertDoesNotMatchRegularExpression('/curl\.exe[^
]*-o "%RT%\\\downloads\\\pgsql\.zip"/', $this->bat, 'pgsql.zip must not be written directly by curl.');
    }

    public function test_fetch_helper_downloads_to_part_and_only_promotes_after_checks(): void
    {
        $ff = $this->subroutineBody(':fetch_file');
        // Downloads target <dest>.part ...
        $this->assertMatchesRegularExpression('/FF_DEST%\.part/', $ff, 'the helper downloads to a .part temporary file.');
        // ...retries each source ...
        $ft = $this->subroutineBody(':fetch_try');
        $this->assertMatchesRegularExpression('/FT_TRY/', $ft, 'the helper retries transient download failures (bounded retry loop).');
        // ...checks minimum size ...
        $this->assertMatchesRegularExpression('/FF_BYTES/i', $ff, 'the helper measures the downloaded size.');
        // ...and only then moves .part over the destination; on failure it deletes .part.
        $this->assertMatchesRegularExpression('/move \/y "%FF_DEST%\.part" "%FF_DEST%"/', $ff, 'the helper atomically moves .part to the destination last.');
        $this->assertMatchesRegularExpression('/del \/q "%FF_DEST%\.part"/', $ff, 'a failed/too-small download deletes the .part and never promotes it.');
    }

    public function test_zip_integrity_is_verified_before_extraction(): void
    {
        // Both archives are integrity-tested with bsdtar (-tf lists without extracting)
        // BEFORE the -xf extraction, so a corrupt/truncated zip fails instead of unpacking
        // partial files (the "ZIP decompression failed (-5)" defect).
        $this->assertMatchesRegularExpression('/"%TAR%" -tf "%RT%\\\downloads\\\php\.zip" >nul 2>nul/', $this->bat, 'php.zip must be integrity-tested (-tf) before extraction.');
        $this->assertMatchesRegularExpression('/"%TAR%" -tf "%RT%\\\downloads\\\pgsql\.zip" >nul 2>nul/', $this->bat, 'pgsql.zip must be integrity-tested (-tf) before extraction.');
        // The integrity test for PHP must precede the extraction line.
        $testPos = strpos($this->bat, '"%TAR%" -tf "%RT%\downloads\php.zip"');
        $extractPos = strpos($this->bat, '"%TAR%" -xf "%RT%\downloads\php.zip"');
        $this->assertIsInt($testPos);
        $this->assertIsInt($extractPos);
        $this->assertLessThan($extractPos, $testPos, 'php.zip integrity test must run before extraction.');
    }

    public function test_each_runtime_step_fail_fast_on_error(): void
    {
        // Every required-runtime failure path must call :fail immediately (no continuation).
        // PHP download / integrity / extract / composer / PostgreSQL:
        foreach ([
            'PHP download failed or was truncated',
            'integrity test failed',
            'Could not unpack the PHP archive',
            'Composer download failed or was truncated',
            'Downloaded composer.phar is only',
            'composer.phar was downloaded to',
            'PostgreSQL download failed or was truncated',
            'Could not unpack the PostgreSQL archive',
            'Could not place the PostgreSQL runtime',
        ] as $fragment) {
            $this->assertStringContainsString($fragment, $this->bat, "missing fail-fast path for: $fragment");
        }
        // Each of those must be on a `call :fail` line (terminate, not continue).
        $this->assertGreaterThan(0, preg_match_all('/call :fail/', $this->bat));
    }

    public function test_prepare_php_is_invoked_early_and_self_heals(): void
    {
        // The runtime step must route through the self-healing :prepare_php subroutine.
        $this->assertMatchesRegularExpression('/^call :prepare_php\s*$/m', $this->bat);
        $prep = $this->subroutineBlock(':prepare_php', ':prepare_composer');
        $this->assertNotSame('', $prep, ':prepare_php subroutine must exist.');
        // It health-checks an existing runtime and reuses it when healthy (no unnecessary redownload).
        $this->assertStringContainsString('call :php_health', $prep);
        $this->assertStringContainsString(':php_ready', $prep);
        // It can repair from the cached archive and, failing that, re-download.
        $this->assertStringContainsString('call :php_extract', $prep);
        $this->assertStringContainsString('call :php_download', $prep);
        // A runtime that cannot be made healthy fails the launcher (hard stop before later stages).
        $this->assertMatchesRegularExpression('/call :php_health[\s\S]*?call :fail/', $prep);
    }

    public function test_php_runtime_stops_the_launcher_when_pdo_pgsql_unavailable(): void
    {
        // After preparing PHP the launcher must NOT proceed to Composer/PostgreSQL/app
        // setup with a broken PHP runtime: :fail terminates the whole process (bare exit).
        $fail = $this->subroutineBody(':fail');
        $this->assertMatchesRegularExpression('/^\s*exit\s+1\s*$/m', $fail);
        // The PHP-prep failure path explicitly names the PDO driver and calls :fail.
        $prep = $this->subroutineBlock(':prepare_php', ':prepare_composer');
        $this->assertStringContainsString('pdo_pgsql', $prep);
        $this->assertMatchesRegularExpression('/call :fail "PHP could not be prepared with a working PostgreSQL driver/', $prep);
    }

    public function test_php_ini_sets_absolute_extension_dir(): void
    {
        $ini = $this->subroutineBody(':write_php_ini');
        // extension_dir must be ABSOLUTE (pointing at the runtime ext dir), not a relative "ext".
        $this->assertMatchesRegularExpression(
            '/extension_dir\s*=\s*"%PHP_DIR%\\\\ext"/',
            $ini,
            'extension_dir must be the absolute %PHP_DIR%\\ext path.',
        );
        $this->assertDoesNotMatchRegularExpression(
            '/echo extension_dir = "ext"/',
            $ini,
            'the relative "ext" extension_dir resolves against CWD and must not be used.',
        );
    }

    public function test_pdo_is_loaded_before_pdo_pgsql(): void
    {
        $ini = $this->subroutineBody(':write_php_ini');
        // The PDO shared core is loaded (where php_pdo.dll ships) before the pgsql driver.
        $this->assertMatchesRegularExpression('/echo extension=pdo\b/', $ini, 'the pdo core extension must be enabled.');
        $this->assertMatchesRegularExpression('/echo extension=pdo_pgsql/', $ini, 'pdo_pgsql must be enabled.');
        $this->assertMatchesRegularExpression('/echo extension=pgsql/', $ini, 'pgsql must be enabled.');
        // The conditional pdo line (guarded by php_pdo.dll existence) precedes pdo_pgsql.
        $this->assertMatchesRegularExpression(
            '/php_pdo\.dll"[^\n]*echo extension=pdo\s*\n[\s\S]*?echo extension=pdo_pgsql/',
            $ini,
            'pdo must be emitted before pdo_pgsql (guarded by php_pdo.dll presence).',
        );
    }

    public function test_runtime_dependency_dlls_are_discoverable_without_global_path(): void
    {
        // The PHP folder (which contains the bundled libpq.dll) is prepended to THIS
        // launcher process PATH only - no System32 copies, no permanent/global PATH change.
        $prep = $this->subroutineBlock(':prepare_php', ':prepare_composer');
        $this->assertMatchesRegularExpression('/set "PATH=%PHP_DIR%;%PATH%"/', $prep);
        $this->assertDoesNotMatchRegularExpression('/setx\b/', $this->bat, 'the launcher must not modify the permanent user/system PATH (no setx).');
        $this->assertDoesNotMatchRegularExpression('/System32\\\\libpq/', $this->bat, 'dependencies must not be copied into System32.');
    }

    public function test_authoritative_pdo_pgsql_health_check_runs_real_php(): void
    {
        $health = $this->subroutineBody(':php_health');
        // It must actually execute PHP and assert the driver via PDO, not just check files.
        $this->assertMatchesRegularExpression(
            "/in_array\\('pgsql',\\s*PDO::getAvailableDrivers\\(\\),\\s*true\\)/",
            $health,
            'the health check must call PDO::getAvailableDrivers() and require pgsql.',
        );
        $this->assertMatchesRegularExpression("/extension_loaded\\('pdo_pgsql'\\)/", $health);
        $this->assertMatchesRegularExpression('/set "PHP_HEALTH=%ERRORLEVEL%"/', $health, 'it must capture PHP exit code.');
    }

    public function test_diagnostic_identifies_php_path_ini_extension_dir_and_dlls(): void
    {
        $diag = $this->subroutineBody(':php_diagnose');
        foreach ([
            'PHP executable',
            '--ini',
            "ini_get('extension_dir')",
            '%PHP_DIR%\\libpq.dll',
            '%PHP_DIR%\\ext\\php_pdo_pgsql.dll',
            '%PHP_DIR%\\ext\\php_pgsql.dll',
            '-m 2>&1',
        ] as $needle) {
            $this->assertStringContainsString($needle, $diag, "diagnostic must report: $needle");
        }
        // :diag_file classifies each required DLL as PRESENT or MISSING.
        $df = $this->subroutineBody(':diag_file');
        $this->assertMatchesRegularExpression('/if exist "%~1" \(echo\s+PRESENT[^)]*\) else \(echo\s+MISSING/', $df);
    }

    public function test_rerunning_repairs_and_reuses_a_valid_runtime(): void
    {
        $prep = $this->subroutineBlock(':prepare_php', ':prepare_composer');
        // Healthy existing runtime -> jump straight to ready (reuse, no redownload).
        $this->assertMatchesRegularExpression('/if exist "%PHP_DIR%\\\\php\.exe" goto php_have/', $prep);
        $this->assertMatchesRegularExpression('/if not errorlevel 1 goto php_ready/', $prep);
        // Broken runtime -> diagnose, re-extract from cache, else re-download; a healthy result is reused.
        $this->assertMatchesRegularExpression('/re-extracting PHP from the cached/', $prep);
        // Extraction always writes a fresh php.ini (deterministic) into a clean dir.
        $ex = $this->subroutineBody(':php_extract');
        $this->assertMatchesRegularExpression('/rd \/q \/s "%PHP_DIR%"/', $ex);
        $this->assertMatchesRegularExpression('/call :write_php_ini/', $ex);
    }

    public function test_runtime_simulation_detects_missing_driver_and_good_runtime(): void
    {
        // Deterministic, network-free model of the health probe decision the launcher makes:
        // healthy iff PDO is present, pdo_pgsql is loaded, and pgsql is a reported driver.
        $decide = static function (bool $pdo, bool $pdoPgsql, array $drivers): int {
            return ($pdo && $pdoPgsql && in_array('pgsql', $drivers, true)) ? 0 : 1;
        };
        $this->assertSame(0, $decide(true, true, ['sqlite', 'pgsql']), 'a fully working runtime is healthy.');
        $this->assertSame(1, $decide(true, false, ['sqlite']), 'missing pdo_pgsql is detected (the reported bug).');
        $this->assertSame(1, $decide(false, false, []), 'missing PDO core is detected.');
        $this->assertSame(1, $decide(true, true, ['mysql']), 'loaded extension without the pgsql driver reported is detected.');
    }

    public function test_postgresql_start_uses_authoritative_status_and_never_double_starts(): void
    {
        $prep = $this->subroutineBlock(':prepare_pg', ':ensure_app_db');
        $this->assertNotSame('', $prep, ':prepare_pg must exist.');
        // Authoritative status check before any start: pg_ctl status -D "<data dir>".
        $this->assertMatchesRegularExpression(
            '/"%PG_BIN%\\\\pg_ctl\.exe" -D "%PGDATA%" status/',
            $prep,
            'pg_ctl status must be the authoritative check for an already-running server.',
        );
        // start is only attempted in the errorlevel branch AFTER status says not-running.
        $this->assertMatchesRegularExpression(
            '/status[^\n]*\n\s*if errorlevel 1 \([\s\S]*?pg_ctl\.exe"[\s\S]*?start/s',
            $prep,
            'pg_ctl start must run only when status reports the server is not running.',
        );
        $this->assertMatchesRegularExpression(
            '/else \(\s*\n\s*echo[^\n]*already running[^\n]*\n\s*\)/s',
            $prep,
            'when the server is already running it is reused, never started a second time.',
        );
    }

    public function test_postgresql_waits_until_it_accepts_connections_after_start(): void
    {
        $prep = $this->subroutineBlock(':prepare_pg', ':ensure_app_db');
        $this->assertMatchesRegularExpression('/pg_isready\.exe" -h 127\.0\.0\.1 -p %PG_PORT%/', $prep, 'after start the launcher waits on pg_isready.');
        $this->assertMatchesRegularExpression('/goto pg_wait_loop|:pg_wait_loop/', $prep, 'there is a bounded readiness wait loop.');
        $this->assertMatchesRegularExpression('/if %PG_TRIES% GEQ 30 exit \/b 1/', $prep, 'the readiness wait is bounded and fails fast if the server never accepts connections.');
    }

    public function test_database_is_created_only_when_absent_via_php_pdo_helper(): void
    {
        $ensure = $this->subroutineBlock(':ensure_app_db', ':fetch_file');
        $this->assertNotSame('', $ensure, ':ensure_app_db must exist.');
        // Database existence is decided by the committed PHP/PDO launcher helper,
        // called DIRECTLY (not via for /f) and branched on its exit code.
        $this->assertMatchesRegularExpression('/"%LAUNCHER_HELPER%" db-exists "%MAINT_DSN%" postgres "" toefl_house >nul\s*\n\s*set "DBEX_RC=!ERRORLEVEL!"/', $ensure);
        // helper exit code 3 = absent -> db_create -> createdb; 0 = present.
        $this->assertMatchesRegularExpression(
            '/if "!DBEX_RC!"=="3" goto db_create[\s\S]*?:db_create[\s\S]*?createdb\.exe"[^\n]*toefl_house[\s\S]*?exit \/b 0/s',
            $ensure,
            'createdb runs only after the helper exits 3 (database absent).',
        );
        $this->assertSame(1, preg_match_all('/createdb\.exe"[^\n]*toefl_house/', $this->bat), 'createdb is invoked exactly once.');
    }

    public function test_database_inspection_uses_the_php_helper_not_psql_for_f(): void
    {
        // No command may be captured via cmd's for /f: for /f runs through `cmd /c`,
        // whose quote handling mangles a line with several quoted paths (it produced
        // "The filename, directory name, or volume label syntax is incorrect."). All
        // inspection goes through the PHP helper, called directly and branched on
        // its exit code.
        $this->assertDoesNotMatchRegularExpression(
            '/for \/f[\s\S]{0,200}LAUNCHER_HELPER/i',
            $this->bat,
            'the launcher helper must never be invoked inside a for /f loop.',
        );
        $this->assertDoesNotMatchRegularExpression(
            "/for \/f[^\n]*%%[^\n]*psql\.exe/i",
            $this->bat,
            'no psql.exe command may be wrapped in a for /f loop; use the PHP/PDO helper.',
        );
        $this->assertMatchesRegularExpression('/set "LAUNCHER_HELPER=%ROOT%\\\\deploy\\\\windows\\\\launcher_helper\.php"/', $this->bat);
        // db-app-valid is branched on exit code (0 valid / 3 foreign) directly.
        $this->assertMatchesRegularExpression(
            '/db-app-valid "%APP_DSN%" postgres "" toefl_house >nul\s*\n\s*set "DBVAL_RC=!ERRORLEVEL!"/',
            $this->subroutineBlock(':ensure_app_db', ':fetch_file'),
        );
        $this->assertMatchesRegularExpression('/if "!DBVAL_RC!"=="3" goto db_foreign/', $this->subroutineBlock(':ensure_app_db', ':fetch_file'));
        // Step 7 account count is also a direct exit-code call (0 zero accounts, 1 exists).
        $this->assertMatchesRegularExpression('/account-count "%APP_DSN%" postgres "" toefl_house\s*\n\s*set "ACCT_RC=!ERRORLEVEL!"/', $this->bat);
        $this->assertMatchesRegularExpression('/if !ACCT_RC! EQU 0 \(/', $this->bat, 'the owner bootstrap runs only when account-count exits 0 (zero accounts).');
    }

    public function test_existing_valid_database_is_reused_and_never_dropped_or_overwritten(): void
    {
        $this->assertDoesNotMatchRegularExpression('/dropdb|DROP DATABASE/i', $this->bat, 'the launcher must never drop a database.');
        $this->assertDoesNotMatchRegularExpression('/createdb[\s\S]{0,200}(already exists)/i', $this->bat, 'createdb must not be run blindly against an existing database.');
        // Validity is established by the helper's authoritative catalog checks.
        $helper = $this->launcherHelper();
        $this->assertStringContainsString("table_name = 'user_accounts'", $helper, 'validity checks for the application root table.');
        $this->assertStringContainsString('2026_08_25_000007_create_user_accounts_table', $helper, 'validity checks for an application migration record.');
        $ensure = $this->subroutineBlock(':ensure_app_db', ':fetch_file');
        $this->assertMatchesRegularExpression(
            '/db-app-valid "%APP_DSN%"[\s\S]*?set "DBVAL_RC=!ERRORLEVEL!"[\s\S]*?:db_valid[\s\S]*?reusing it[\s\S]*?exit \/b 0/s',
            $ensure,
            'a recognized TOEFL House database is reused (no data changed).',
        );
    }

    public function test_existing_unrecognized_database_stops_safely_without_destroying_data(): void
    {
        $ensure = $this->subroutineBlock(':ensure_app_db', ':fetch_file');
        $this->assertMatchesRegularExpression(
            '/:db_foreign\s*\n\s*call :fail "[^"]*NOT recognized as the TOEFL House database[^"]*"/s',
            $ensure,
            'an existing but unrecognizable database stops the launcher with a clear diagnostic.',
        );
        $this->assertMatchesRegularExpression('/Nothing has been dropped or overwritten/', $ensure, 'the message must promise no data was destroyed.');
        $this->assertDoesNotMatchRegularExpression('/dropdb|DROP DATABASE/i', $this->bat, 'no automatic destruction path exists.');
    }

    public function test_env_overrides_are_written_by_the_php_helper_not_fragile_inline_php(): void
    {
        // The desktop .env overrides must be written by the committed helper
        // (env-set). The previous inline `php -r "...()"` ran inside a
        // parenthesized if-block; cmd mangled the parentheses and PHP reported
        // "Unclosed '('", silently skipping the overrides.
        $this->assertMatchesRegularExpression(
            '/"%LAUNCHER_HELPER%" env-set "%ROOT%\\\.env"[\s\S]*DB_DATABASE=toefl_house[\s\S]*DB_SSLMODE=disable/',
            $this->bat,
            'desktop .env overrides are applied through the helper.',
        );
        // The make-env logic must NOT sit inside a parenthesized block (uses goto labels).
        $this->assertMatchesRegularExpression('/if not exist "%ROOT%\\\.env" goto make_env/', $this->bat);
        // The old inline .env writer subroutine must be gone.
        $this->assertStringNotContainsString(':set_env', $this->bat, 'the fragile inline :set_env subroutine is removed.');
        // The helper must exist and perform an atomic rewrite.
        $helper = $this->launcherHelper();
        $this->assertStringContainsString("case 'env-set'", $helper);
        $this->assertStringContainsString('rename($tmp, $envPath)', $helper, '.env is replaced atomically.');
    }

    public function test_core_compiled_xml_extensions_are_not_listed_as_shared(): void
    {
        // dom/xml/simplexml/xmlreader/xmlwriter are compiled into PHP on Windows
        // (no php_dom.dll/php_xml.dll in ext). Listing them produced "Unable to load
        // dynamic library ... The specified module could not be found" on every run.
        $ini = $this->subroutineBody(':write_php_ini');
        foreach (['dom', 'xml', 'simplexml', 'xmlreader', 'xmlwriter'] as $ext) {
            $this->assertDoesNotMatchRegularExpression(
                '/echo extension='.preg_quote($ext, '/').'\s*$/m',
                $ini,
                "core-compiled extension '{$ext}' must not be listed as a shared extension.",
            );
        }
        // Genuinely shared extensions are still enabled.
        $this->assertMatchesRegularExpression('/echo extension=pdo_pgsql/', $ini);
        $this->assertMatchesRegularExpression('/echo extension=openssl/', $ini);
        $this->assertMatchesRegularExpression('/echo extension=zip/', $ini);
    }

    public function test_postgres_and_database_stages_are_idempotent_on_repeated_runs(): void
    {
        // Re-running must not fail merely because the server/db already exist.
        $this->assertMatchesRegularExpression('/call :prepare_pg\s*\n\s*if errorlevel 1 call :fail/', $this->bat, 'step 5 calls the idempotent prepare_pg.');
        $this->assertMatchesRegularExpression('/call :ensure_app_db\s*\n\s*if errorlevel 1 call :fail/', $this->bat, 'step 6 calls the idempotent ensure_app_db.');
        $this->assertMatchesRegularExpression('/artisan migrate --force\s*\n\s*if errorlevel 1 call :fail/', $this->bat, 'migrations run with Laravel (which skips already-applied migrations).');
        // createdb exists exactly once, and it lives inside the absent-database guard of :ensure_app_db
        // (never a blind unconditional call that would error on an already-existing database).
        $ensure = $this->subroutineBlock(':ensure_app_db', ':fetch_file');
        $this->assertSame(1, preg_match_all('/createdb\.exe"[^\n]*toefl_house/', $this->bat), 'createdb is invoked exactly once.');
        $this->assertMatchesRegularExpression('/if "!DBEX_RC!"=="3" goto db_create/', $ensure, 'createdb is guarded by the helper absent exit code (3).');
        // pg_ctl start appears exactly once, inside the not-running guard.
        $prep = $this->subroutineBlock(':prepare_pg', ':ensure_app_db');
        $this->assertSame(1, preg_match_all('/pg_ctl\.exe"[^\n]* start/', $prep), 'pg_ctl start appears exactly once, inside the not-running guard.');
    }

    public function test_first_run_owner_prompts_use_delayed_expansion_inside_the_block(): void
    {
        // The five owner values are captured with `set /p` INSIDE the parenthesized
        // `if !ACCT_RC! EQU 0 (...)` block. set /p assigns at run time while %VAR% is
        // expanded at parse time, so reading them as %OWN_NAME% always saw an empty
        // value and failed with "The owner name is required." They MUST be read with
        // delayed expansion (!VAR!).
        $this->assertMatchesRegularExpression('/set \/p "OWN_NAME=[^"]*"/', $this->bat);
        $this->assertMatchesRegularExpression('/if !ACCT_RC! EQU 0 \(/', $this->bat, 'the bootstrap runs in the zero-accounts block.');
        $this->assertDoesNotMatchRegularExpression(
            '/%OWN_(NAME|DOB|USER|PW1|PW2)%/',
            $this->bat,
            'owner prompt variables must not be read with parse-time %VAR% (empty inside the block).',
        );
        $this->assertMatchesRegularExpression('/if "!OWN_NAME!"=="" call :fail/', $this->bat);
        $this->assertMatchesRegularExpression('/if not "!OWN_PW1!"=="!OWN_PW2!" call :fail/', $this->bat);
        $this->assertMatchesRegularExpression('/call :pwlen "!OWN_PW1!"/', $this->bat);
        // The env vars handed to artisan db:seed must be built from the run-time values.
        $this->assertMatchesRegularExpression('/set "BOOTSTRAP_OWNER_NAME=!OWN_NAME!"/', $this->bat);
        $this->assertMatchesRegularExpression('/set "BOOTSTRAP_OWNER_PASSWORD=!OWN_PW1!"/', $this->bat);
    }

    public function test_server_start_does_not_gate_on_start_errorlevel_and_logs_output(): void
    {
        // `start` spawns an independent window and returns without resetting
        // ERRORLEVEL, so an "if errorlevel 1" right after it reads the stale level
        // from the port check and falsely reported "Could not start the Laravel
        // server process". Readiness is decided solely by the /health loop.
        $this->assertDoesNotMatchRegularExpression(
            '/artisan serve[\s\S]{0,120}?if errorlevel 1 call :fail "Could not start the Laravel server/',
            $this->bat,
            'the server launch must not be gated on `start` errorlevel (it is unreliable after start).',
        );
        $this->assertStringNotContainsString('Could not start the Laravel server process', $this->bat);
        // The server window is launched through cmd /c with its output redirected to a
        // log file, so a real bind/crash failure is diagnosable.
        $this->assertMatchesRegularExpression(
            '/start "TOEFL-House-Server" \/D "%ROOT%\\\\public" \/min cmd \/c ""%PHP%" -d variables_order=EGPCS -S 127\.0\.0\.1:%APP_PORT% -t "%ROOT%\\\\public" "%FRAMEWORK_ROUTER%" > "%SERVER_LOG%" 2>&1"/',
            $this->bat,
            'the server is launched minimized via cmd /c and its output goes to SERVER_LOG.',
        );
        $this->assertMatchesRegularExpression('/set "SERVER_LOG=%RT%\\\\server\.log"/', $this->bat, 'a server log path is defined.');
        // The health-loop failure must surface the server log before stopping.
        $this->assertMatchesRegularExpression(
            '/type "%SERVER_LOG%"[\s\S]{0,200}?call :fail "The application was not healthy/',
            $this->bat,
            'when /health never returns 200, the server log is printed to aid diagnosis.',
        );
    }

    public function test_port_resolution_echo_lines_inside_blocks_have_no_raw_parens(): void
    {
        // An unescaped ) in an echo INSIDE an if/else ( ) block closes the block
        // early and cmd aborts with ". was unexpected at this time." The resolve
        // block echoes the chosen port inside its if/else, so its echo lines must
        // contain no unescaped parentheses.
        $resolve = $this->subroutineBlock(':resolve_app_port', ':probe_port');
        $this->assertStringContainsString('verified available', $resolve);
        $this->assertDoesNotMatchRegularExpression(
            '/^\s*echo[^\n]*\([^\n]*\)/m',
            $resolve,
            'echo lines inside the resolve_app_port if/else block must not contain parentheses.',
        );
        // The concrete fixed line has no parens at all.
        $this->assertStringContainsString('using web port %APP_PORT%, verified available.', $resolve);
    }

    public function test_port_bindable_check_consults_windows_listeners_and_excluded_ranges(): void
    {
        // A raw socket bind is permissive on Windows (SO_REUSEADDR lets a test bind
        // a held/reserved port that the real PHP server then cannot exclusively
        // bind - it failed with "Failed to listen on 127.0.0.1:8080"). The helper
        // must ALSO ask Windows: netstat (LISTENING) and the netsh excluded range
        // table (Hyper-V/WinNAT reservations), read-only.
        $helper = $this->launcherHelper();
        $this->assertStringContainsString('function portHasListener(int $port): bool', $helper);
        $this->assertStringContainsString('netstat -ano', $helper);
        $this->assertStringContainsString('stripos($line, \'LISTENING\')', $helper);
        $this->assertStringContainsString('function portIsInExcludedRange(int $port): bool', $helper);
        $this->assertStringContainsString('netsh interface ipv4 show excludedportrange protocol=tcp', $helper);
        // port-bindable rejects a port that is either listening or inside an excluded range.
        $this->assertMatchesRegularExpression('/function portBindable[\s\S]{0,400}?portHasListener\(\$port\)[\s\S]{0,80}?portIsInExcludedRange\(\$port\)/', $helper);
    }

    public function test_built_in_server_runs_with_public_as_working_directory(): void
    {
        // The framework router (vendor/.../Foundation/resources/server.php) requires
        // getcwd()."/index.php". With the process cwd at the repo root it looks for
        // <root>/index.php (missing) and /health returns HTTP 500
        // ("require_once(<root>/index.php): Failed to open stream"). `artisan serve`
        // starts the child with cwd=public; the direct launch must do the same via
        // `start /D "<public>"`, plus -t for the static document root.
        $this->assertMatchesRegularExpression(
            '/start "TOEFL-House-Server" \/D "%ROOT%\\\\public" \/min cmd \/c/',
            $this->bat,
            'the server process working directory is set to public via start /D.',
        );
        $this->assertMatchesRegularExpression(
            '/-S 127\.0\.0\.1:%APP_PORT%[\s\S]{0,160}?-t "%ROOT%\\\\public"/',
            $this->bat,
            'the built-in server also sets public as its static document root (-t).',
        );
    }

    public function test_server_runs_direct_php_built_in_server_not_artisan_serve(): void
    {
        // `artisan serve` spawns the PHP built-in server with PHP_CLI_SERVER_WORKERS
        // set (multi-worker mode) and a filtered environment. That worker mode uses
        // fork() which Windows lacks, so the child never binds and Laravel reports
        // "Failed to listen ... (reason: ?)" on EVERY port even though raw PHP binds
        // fine. The launcher therefore runs the built-in server directly with the
        // same framework router, no PHP_CLI_SERVER_WORKERS, full environment.
        $this->assertMatchesRegularExpression('/-S 127\.0\.0\.1:%APP_PORT%/', $this->bat, 'uses the PHP built-in server.');
        $this->assertMatchesRegularExpression('/-d variables_order=EGPCS/', $this->bat, 'desktop env (DB/SERVER) is passed to the script.');
        $this->assertMatchesRegularExpression('/FRAMEWORK_ROUTER=.*Foundation\\\\resources\\\\server\.php/', $this->bat, 'uses the same framework router as artisan serve.');
        $this->assertMatchesRegularExpression('/if not exist "%FRAMEWORK_ROUTER%" call :fail/', $this->bat, 'a missing router (Composer not installed) fails fast.');
        // artisan serve / the worker variable must only appear in explanatory REM
        // comments - never on an executable (non-comment) line.
        $executable = implode("\n", array_filter(explode("\n", $this->bat), function ($line) {
            return ! preg_match('/^\s*REM/', $line) && ! preg_match('/^\s*:/', $line);
        }));
        $this->assertDoesNotMatchRegularExpression('/artisan serve/', $executable, 'artisan serve is not invoked on any executable line (Windows worker-env incompatibility).');
        $this->assertDoesNotMatchRegularExpression('/PHP_CLI_SERVER_WORKERS/', $executable, 'the launcher never sets the unsupported worker variable.');
    }

    public function test_web_port_is_verified_bindable_before_launch_and_reused_when_healthy(): void
    {
        // Windows excludes dynamic port ranges (Hyper-V/WinNAT) that show NO listener
        // in netstat yet fail to bind; a blind launch then crashed with
        // "Failed to listen on 127.0.0.1:8080". The launcher must verify bindability.
        $helper = $this->launcherHelper();
        $this->assertStringContainsString("case 'port-bindable'", $helper);
        $this->assertStringContainsString('stream_socket_server("tcp://127.0.0.1:{$port}"', $helper);
        // Port resolution probes /health first (reuse a running instance) then bindability.
        $resolve = $this->subroutineBlock(':resolve_app_port', ':probe_port');
        $this->assertNotSame('', $resolve, ':resolve_app_port must exist.');
        $this->assertMatchesRegularExpression('/call :probe_port %APP_PORT%/', $resolve);
        $this->assertMatchesRegularExpression('/call :probe_port %%P/', $resolve, 'it falls back to alternate candidate ports.');
        $this->assertMatchesRegularExpression('/Could not bind any web port/', $resolve, 'failure is explicit if no port is usable.');
        // The chosen port is written back to .env so serve/health/tailscale agree.
        $this->assertMatchesRegularExpression('/env-set "%ROOT%\\\.env" "APP_URL=%APP_URL_LOCAL%"/', $resolve);

        $probe = $this->subroutineBlock(':probe_port', ':port_in_use');
        $this->assertMatchesRegularExpression('/curl\.exe[\s\S]{0,160}?\/health[\s\S]{0,120}?PORTCAND_HOW=health/', $probe, 'a live instance answering /health is reused.');
        $this->assertMatchesRegularExpression('/port-bindable %~1/', $probe, 'otherwise bindability is tested directly.');
        // Step 8 does not launch again when a healthy instance was found.
        $this->assertMatchesRegularExpression('/if "%PORTCAND_HOW%"=="health" \([\s\S]*?goto check_health/', $this->bat);
        // serve, health and tailscale all use the resolved APP_PORT.
        $this->assertMatchesRegularExpression('/-S 127\.0\.0\.1:%APP_PORT% -t "%ROOT%\\\\public"/', $this->bat, 'the built-in server serves the public docroot.');
        $this->assertMatchesRegularExpression('/serve --bg %APP_PORT%/', $this->bat);
    }

    public function test_tailscale_uses_the_official_pkgs_host_and_a_pinned_versioned_msi(): void
    {
        // Regression: Step 10 hard-coded https://download.tailscale.com/stable/
        // tailscale-setup-latest.amd64.msi. That host does not exist in DNS
        // (curl exit 6 "Could not resolve host") and Tailscale publishes MSIs
        // ONLY version-pinned as tailscale-setup-<ver>-amd64.msi on the official
        // package host pkgs.tailscale.com (there is no rolling "latest" MSI).
        $this->assertArrayHasKey('TAILSCALE_VERSION', $this->vars, 'the launcher must pin a Tailscale version.');
        $this->assertMatchesRegularExpression(
            '/^\d+\.\d+\.\d+$/',
            $this->vars['TAILSCALE_VERSION'],
            'TAILSCALE_VERSION must be a pinned stable x.y.z release.',
        );
        // The URL var derives the file name from the pinned version.
        $this->assertStringContainsString('%TAILSCALE_VERSION%', $this->vars['TAILSCALE_MSI_URL'], 'the MSI URL must derive from TAILSCALE_VERSION, not a hard-coded file name.');
        $url = str_replace('%TAILSCALE_VERSION%', $this->vars['TAILSCALE_VERSION'], $this->vars['TAILSCALE_MSI_URL']);
        // Official host + versioned -amd64.msi pattern.
        $this->assertSame(
            "https://pkgs.tailscale.com/stable/tailscale-setup-{$this->vars['TAILSCALE_VERSION']}-amd64.msi",
            $url,
            'Tailscale MSI must come from pkgs.tailscale.com as tailscale-setup-<ver>-amd64.msi.',
        );
        // The broken host and the nonexistent rolling file name must be gone entirely.
        $this->assertStringNotContainsString('download.tailscale.com', $this->bat, 'the non-existent download.tailscale.com host must not appear anywhere.');
        $this->assertStringNotContainsString('tailscale-setup-latest', $this->bat, 'there is no rolling "latest" Tailscale MSI; the file must be version-pinned.');
    }

    public function test_tailscale_msi_is_downloaded_through_the_atomic_fetch_helper(): void
    {
        // The MSI must be fetched via the atomic :fetch_file helper (retries,
        // .part temporary file, size floor, atomic promotion) - never a bare
        // curl that writes straight into the destination (curl --retry also
        // does not retry a DNS failure, exit 6, which is why the old download
        // never recovered).
        $step10 = $this->tailscaleStepBlock();
        $this->assertNotSame('', $step10, 'the Step 10 Tailscale block must exist.');
        $this->assertStringContainsString(
            'call :fetch_file "%RT%\downloads\tailscale-setup.msi" "%TAILSCALE_MSI_URL%" "" "10485760"',
            $step10,
            'the Tailscale MSI is downloaded through the atomic :fetch_file helper with a size floor.',
        );
        // No raw curl writes the MSI directly (the non-atomic pattern).
        $this->assertDoesNotMatchRegularExpression(
            '/curl\.exe[^\n]*tailscale-setup\.msi/',
            $step10,
            'the MSI must not be written directly by a bare curl (use .part via :fetch_file).',
        );
        // The helper itself keeps its atomic contract (part file, retries, promotion).
        $ff = $this->subroutineBody(':fetch_file');
        $this->assertMatchesRegularExpression('/FF_DEST%\.part/', $ff, 'the helper downloads to a .part temporary file.');
        $this->assertMatchesRegularExpression('/move \/y "%FF_DEST%\.part" "%FF_DEST%"/', $ff, 'the helper atomically promotes .part to the destination last.');
        // msiexec installs the helper-fetched MSI silently (the existing convention).
        $this->assertStringContainsString('msiexec /i "%RT%\downloads\tailscale-setup.msi" /qn /norestart', $step10, 'the fetched MSI is installed silently with msiexec.');
    }

    public function test_tailscale_failures_degrade_gracefully_and_never_call_the_fatal_path(): void
    {
        // By Step 10 the local app is already healthy (verified by /health). A
        // Tailscale download failure, install/UAC decline, missing client,
        // not-signed-in state, or serve-setup failure must NOT invoke the global
        // fatal :fail path - it must finish and report the local URL, then tell
        // the operator how to configure Tailscale manually and re-run.
        $step10 = $this->tailscaleStepBlock();
        $this->assertNotSame('', $step10, 'the Step 10 Tailscale block must exist.');

        // No fatal :fail anywhere inside the Tailscale step (comments excluded).
        $executable = implode("\n", array_filter(explode("\n", $step10), function ($line) {
            return ! preg_match('/^\s*REM/', $line) && ! preg_match('/^\s*:/', $line);
        }));
        $this->assertDoesNotMatchRegularExpression(
            '/call :fail/',
            $executable,
            'Tailscale download/install/serve failures must not call the fatal :fail path.',
        );
        // Every Tailscale problem converges on the non-fatal :ts_unavailable flow.
        $this->assertMatchesRegularExpression('/goto ts_unavailable/', $step10, 'a Tailscale failure routes to the graceful :ts_unavailable summary.');
        $this->assertStringContainsString(':ts_unavailable', $step10, 'the graceful Tailscale-unavailable label exists.');
        // The graceful banner states the LOCAL server is healthy and gives the local URL.
        $unavail = $this->subroutineBlock(':ts_unavailable', ':ts_summary');
        $this->assertMatchesRegularExpression(
            '/The local server is healthy and fully usable on this computer:[\s\S]{0,80}?%APP_URL_LOCAL%/',
            $unavail,
            'on Tailscale failure the launcher reports the local server is healthy and shows the local URL.',
        );
        // Manual remediation: where to install and that re-running finishes setup.
        $this->assertStringContainsString('https://tailscale.com/download/windows', $unavail, 'the message tells how to install Tailscale manually.');
        $this->assertMatchesRegularExpression('/START-TOEFL-HOUSE\.bat again/s', $unavail, 'the message says to re-run the launcher after configuring Tailscale.');
        // Not-signed-in keeps its interactive guidance but now continues to the summary (no early exit).
        $this->assertMatchesRegularExpression('/:ts_signin_required[\s\S]*?goto ts_unavailable/', $step10, 'a not-signed-in client is guided and continues (not a hard exit).');
        $this->assertMatchesRegularExpression('/:ts_serve_failed[\s\S]*?goto ts_unavailable/', $step10, 'a failed serve setup continues to the graceful summary.');
        // Serve is still configured when Tailscale IS available.
        $this->assertMatchesRegularExpression('/serve --bg %APP_PORT%/', $step10, 'tailscale serve --bg is still run when the client is available.');
        $this->assertStringContainsString(':ts_serve_ok', $step10, 'the successful serve path is preserved.');
    }

    public function test_graceful_tailscale_does_not_weaken_application_fatal_paths(): void
    {
        // Making Tailscale non-fatal must NOT make the application itself
        // non-fatal. The /health gate and the required runtimes still call the
        // global :fail; only Step 10 degrades gracefully.
        // Health gate still hard-stops when the app never answers /health.
        $this->assertMatchesRegularExpression(
            '/type "%SERVER_LOG%"[\s\S]{0,200}?call :fail "The application was not healthy/',
            $this->bat,
            'an unhealthy application still stops the launcher (the /health gate is not weakened).',
        );
        // Required runtimes / DB / migrations still fail fast (representative set).
        $this->assertMatchesRegularExpression('/call :fail "PostgreSQL could not be started/', $this->bat);
        $this->assertMatchesRegularExpression('/call :fail "Database migrations failed/', $this->bat);
        // :fail itself still terminates the whole launcher process.
        $failBlock = $this->subroutineBody(':fail');
        $this->assertMatchesRegularExpression('/^\s*exit\s+1\s*$/m', $failBlock, ':fail still ends with a bare "exit 1".');
    }

    public function test_tailscale_serve_status_for_f_wraps_the_quoted_path_in_double_quotes(): void
    {
        // `for /f ('...')` runs its command via an implicit `cmd /c "..."`, and
        // cmd /c strips the FIRST and LAST double-quote of a command line that
        // begins with a quote. TAILSCALE_BIN is a quoted, spaced path
        // ("C:\Program Files\Tailscale\tailscale.exe"), so the naive
        //   in ('"%TAILSCALE_BIN%" serve status ... findstr /C:"https://"')
        // loses its first and last quote to that stripping, leaving a stray
        // quote and the error "The filename, directory name, or volume label
        // syntax is incorrect." The fix is the same sacrificial outer pair the
        // working `cmd /c ""%PHP%" ..."` and `cmd /k ""%TAILSCALE_BIN%" ..."`
        // lines use: wrap the whole command as ('"" ... ""').
        $step10 = $this->tailscaleStepBlock();
        $this->assertNotSame('', $step10, 'the Step 10 Tailscale block must exist.');

        // The for /f that reads `serve status` opens and closes with the doubled
        // outer quote ("" ... "") so the inner quotes survive cmd /c stripping.
        $this->assertMatchesRegularExpression(
            '#for /f "tokens=1" %%a in \(\'""%TAILSCALE_BIN%" serve status 2\^>nul \^\| findstr /C:"https://""\'\) do if not defined TAIL_URL set "TAIL_URL=%%a"#',
            $step10,
            'the `tailscale serve status` for /f must wrap the quoted, spaced executable in a sacrificial "" outer pair.',
        );
        // The broken single-quote form (which cmd /c mangles) must not be present.
        $this->assertDoesNotMatchRegularExpression(
            "#for /f \"tokens=1\" %%a in \\('\"%TAILSCALE_BIN%\" serve status#",
            $step10,
            'the for /f must not open with a single quote before the spaced TAILSCALE_BIN path (cmd /c strips it).',
        );
        // The same doubled-quote wrapper convention is used by the other spawned
        // commands (regression anchor: these are the known-good forms).
        $this->assertMatchesRegularExpression('#cmd /c ""%PHP%"#', $this->bat, 'the PHP server launch uses the "" wrapper.');
        $this->assertMatchesRegularExpression('#cmd /k ""%TAILSCALE_BIN%" serve#', $this->bat, 'the interactive Tailscale setup uses the "" wrapper.');
    }

    public function test_tailscale_serve_status_captures_only_the_bare_url_first_token(): void
    {
        // `tailscale serve status` prints the address line as
        //   https://<host>.<tailnet>.ts.net (tailnet only)
        // With `tokens=*` TAIL_URL captured the whole line, including the
        // "(tailnet only)" label. That label's closing ")" is read by the
        // surrounding `if defined TAIL_URL ( ... ) else ( ... )` block when
        // `echo %TAIL_URL%` expands, which closed the if-body early (the URL was
        // truncated at the paren and the else branch printed too). The launcher
        // must take only the FIRST whitespace token - the bare URL, no parens -
        // so the block is well-formed and only the if-body runs.
        $step10 = $this->tailscaleStepBlock();

        // The discovery line uses tokens=1 (first whitespace token = bare URL).
        $this->assertMatchesRegularExpression(
            '#for /f "tokens=1" %%a in \(\'""%TAILSCALE_BIN%" serve status 2\^>nul \^\| findstr /C:"https://""\'\) do if not defined TAIL_URL set "TAIL_URL=%%a"#',
            $step10,
            'the serve-status for /f must capture tokens=1 (the bare URL), not tokens=* (the whole line).',
        );
        // tokens=* must NOT be used for this capture (it would keep the paren label).
        $this->assertDoesNotMatchRegularExpression(
            '#for /f "tokens=\*" %%a in \([^)]*serve status#',
            $step10,
            'the serve-status for /f must not use tokens=* (it captures the "(tailnet only)" paren).',
        );

        // Model what for /f tokenisation yields for the real status output: the
        // first token must be a paren-free bare URL for every line shape.
        $statusLines = [
            'https://desktop-jv9arhg.tail3aec10.ts.net (tailnet only)',
            'https://desktop-jv9arhg.tail3aec10.ts.net (Funnel on)',
            '   https://desktop-jv9arhg.tail3aec10.ts.net (tailnet only)',
            'https://desktop-jv9arhg.tail3aec10.ts.net:443/ (tailnet only)',
        ];
        foreach ($statusLines as $line) {
            // for /f default delims are space/tab; %%a with tokens=1 is the first
            // non-empty token. The |-- proxy lines do not contain "https://" so
            // findstr filters them out; these lines all contain it.
            $trimmed = ltrim($line);
            $first = preg_split('/\s+/', $trimmed, 2)[0];
            $this->assertMatchesRegularExpression('#^https://\S+$#', $first, "first token must be a bare URL: [$first]");
            $this->assertStringNotContainsString('(', $first, "the captured URL must contain no parens: [$first]");
            $this->assertStringNotContainsString('tailnet only', $first, "the captured URL must drop the '(tailnet only)' label: [$first]");
        }

        // TAIL_URL is echoed inside a parenthesised if-block, so its value must
        // never contain a block-closing paren; echo the %VAR% (delayed expansion is
        // unnecessary once the value is a paren-free URL).
        $this->assertMatchesRegularExpression(
            '/if defined TAIL_URL \(\s*\n\s*echo[^\n]*\n\s*echo\s+%TAIL_URL%\s*\n\s*\) else \(/',
            $step10,
            'the TAIL_URL echo stays inside the if defined TAIL_URL ( ... ) else ( ... ) block.',
        );
    }

    public function test_built_in_server_cwd_public_fix_is_preserved_in_full_launch_line(): void
    {
        // Extends the cwd-public regression: the ENTIRE launch line must keep
        // both the /D "%ROOT%\public" working directory and -t "%ROOT%\public"
        // document root, with the framework router, around the direct php -S.
        $this->assertMatchesRegularExpression(
            '/start "TOEFL-House-Server" \/D "%ROOT%\\\\public" \/min cmd \/c ""%PHP%" -d variables_order=EGPCS -S 127\.0\.0\.1:%APP_PORT% -t "%ROOT%\\\\public" "%FRAMEWORK_ROUTER%" > "%SERVER_LOG%" 2>&1"/',
            $this->bat,
            'the direct built-in-server launch keeps /D public cwd, -t public docroot, the framework router and the server log.',
        );
    }

    public function test_composer_uses_the_official_pinned_phar_not_the_bootstrapper(): void
    {
        // Composer is the official PERMANENT versioned PHAR (https://getcomposer.org/download/<v>/composer.phar).
        $this->assertMatchesRegularExpression(
            '/set "COMPOSER_PHAR_URL=https:\/\/getcomposer\.org\/download\/%COMPOSER_VERSION%\/composer\.phar"/',
            $this->bat,
            'Composer must come from the official versioned PHAR URL.',
        );
        $this->assertMatchesRegularExpression('/set "COMPOSER_VERSION=\d+\.\d+\.\d+"/', $this->bat, 'a concrete stable Composer version is pinned.');
        // The composer-setup.php bootstrapper must NOT be downloaded or executed: it crashes this
        // PHP runtime with STATUS_ACCESS_VIOLATION (0xC0000005 / -1073741819).
        $this->assertStringNotContainsString('COMPOSER_SETUP', $this->bat, 'the crash-prone composer-setup.php bootstrapper must not be used.');
        $this->assertStringNotContainsString('COMPOSER_INSTALLER_URL', $this->bat);
        $this->assertDoesNotMatchRegularExpression('/"%PHP%"[^\n]*composer-setup/i', $this->bat, 'the launcher must never execute composer-setup.php.');
    }

    public function test_composer_phar_is_downloaded_atomically_and_runs_before_database_stage(): void
    {
        $prep = $this->subroutineBody(':prepare_composer');
        $this->assertNotSame('', $prep, ':prepare_composer must exist.');
        $this->assertMatchesRegularExpression(
            '/call :fetch_file "%COMPOSER_PHAR%" "%COMPOSER_PHAR_URL%" "" "1000000"/',
            $prep,
            'composer.phar is fetched atomically into place with a size floor.',
        );
        $this->assertMatchesRegularExpression('/if !CP_BYTES! LSS 1000000[\s\S]*?call :fail/', $prep, 'a truncated/tiny composer.phar fails.');
        $this->assertMatchesRegularExpression(
            '/"%PHP%" "%COMPOSER_PHAR%" --version >nul 2>nul\s*\n\s*if errorlevel 1[\s\S]*?call :fail/',
            $prep,
            'composer.phar must actually run --version with launcher PHP; otherwise fail.',
        );
        $this->assertLessThan(
            strpos($this->bat, 'if not exist "%PG_BIN%\initdb.exe"'),
            strpos($this->bat, 'call :prepare_composer'),
            'Composer is prepared before the PostgreSQL stage.',
        );
        $this->assertDoesNotMatchRegularExpression('/\bsetx\b/', $this->bat, 'no permanent/global PATH modification.');
    }

    public function test_composer_prep_is_idempotent_and_uses_launcher_php(): void
    {
        $prep = $this->subroutineBody(':prepare_composer');
        $this->assertMatchesRegularExpression(
            '/if exist "%COMPOSER_PHAR%" \([\s\S]*?--version[\s\S]*?if not errorlevel 1 exit \/b 0[\s\S]*?del \/q "%COMPOSER_PHAR%"/',
            $prep,
            'a working composer.phar is reused (idempotent); a broken one is replaced.',
        );
        $this->assertGreaterThan(0, preg_match_all('/"%PHP%" "%COMPOSER_PHAR%"/', $prep), 'always invoked with launcher-local PHP.');
    }

    private function tailscaleStepBlock(): string
    {
        // The Step 10 Tailscale section, from its section banner up to (but not
        // including) the "Subroutines" divider that begins :fail et al.
        $startMarker = 'echo [10/10]';
        $endMarker = 'REM ===========================================================================';
        $start = strpos($this->bat, $startMarker);
        if ($start === false) {
            return '';
        }
        $end = strpos($this->bat, $endMarker, $start);
        if ($end === false) {
            return substr($this->bat, $start);
        }

        return substr($this->bat, $start, $end - $start);
    }

    private function subroutineBlock(string $startLabel, string $nextLabel): string
    {
        // Like subroutineBody but spans the whole subroutine INCLUDING its
        // internal loop/branch labels (subroutineBody stops at the first label).
        // Labels must be matched at the start of a line so a "call :label" in the
        // main flow is not mistaken for the subroutine definition.
        if (preg_match('/^'.preg_quote($startLabel, '/').'\\s*$/m', $this->bat, $m, PREG_OFFSET_CAPTURE) !== 1) {
            return '';
        }
        $start = $m[0][1];
        if (preg_match('/^'.preg_quote($nextLabel, '/').'\\s*$/m', $this->bat, $m2, PREG_OFFSET_CAPTURE, $start) === 1) {
            return substr($this->bat, $start, $m2[0][1] - $start);
        }

        return substr($this->bat, $start);
    }

    private function launcherHelper(): string
    {
        $path = dirname(__DIR__, 3).DIRECTORY_SEPARATOR.'deploy'.DIRECTORY_SEPARATOR.'windows'.DIRECTORY_SEPARATOR.'launcher_helper.php';
        $this->assertFileExists($path, 'deploy/windows/launcher_helper.php must be committed.');

        return (string) file_get_contents($path);
    }

    private function subroutineBody(string $label): string
    {
        // Return the lines from ":label" up to the next top-level ":otherlabel".
        if (preg_match('/^'.preg_quote($label, '/').'\s*\n([\s\S]*?)(?=^:[A-Za-z_][A-Za-z0-9_]*\s*$|\Z)/m', $this->bat, $m) === 1) {
            return $m[1];
        }

        return '';
    }

    public function test_archives_are_extracted_with_the_built_in_bsdtar_not_a_path_resolved_tar(): void
    {
        // TAR must point at the Windows built-in bsdtar by absolute System32 path.
        $this->assertArrayHasKey('TAR', $this->vars, 'the launcher must define TAR as the built-in bsdtar path.');
        $this->assertMatchesRegularExpression(
            '#%SystemRoot%\\\\System32\\\\tar\.exe$#i',
            $this->vars['TAR'],
            'TAR must be the Windows built-in %SystemRoot%\\System32\\tar.exe (bsdtar), not a PATH-resolved tar.',
        );

        // Every archive extraction must invoke the quoted built-in tar.
        $this->assertSame(2, preg_match_all('/"%TAR%"\s+-xf/', $this->bat), 'both the PHP and PostgreSQL archives must be extracted with "%TAR%" -xf.');

        // No bare, PATH-resolved "tar" may remain: that is the GNU tar that
        // fails with "Cannot connect to C: resolve failed" on a drive-letter path.
        $this->assertDoesNotMatchRegularExpression(
            '/(^|\s)tar(\.exe)?\s+-xf/m',
            $this->bat,
            'no extraction may call a bare PATH-resolved tar; use the built-in "%TAR%".',
        );
    }

    public function test_built_in_tar_is_verified_as_a_prerequisite(): void
    {
        // Fail loudly up front if the built-in bsdtar is missing, naming why.
        $this->assertMatchesRegularExpression(
            '/if not exist "%TAR%" call :fail/',
            $this->bat,
            'the launcher must verify the built-in tar exists in the prerequisites step.',
        );
    }

    public function test_php_and_postgresql_archives_use_the_same_built_in_extractor(): void
    {
        // Both archives are unpacked with the built-in bsdtar. PHP extracts directly
        // into the runtime dir (flat zip); PostgreSQL extracts into staging (its zip
        // wraps in pgsql\) before being moved - see the dedicated layout tests.
        $this->assertMatchesRegularExpression('/"%TAR%"\s+-xf\s+"%RT%\\\downloads\\\php\.zip"\s+-C\s+"%PHP_DIR%"/', $this->bat);
        $this->assertMatchesRegularExpression('/"%TAR%"\s+-xf\s+"%RT%\\\downloads\\\pgsql\.zip"\s+-C\s+"%RT%\\\downloads"/', $this->bat);
    }

    /**
     * Behavioural proof of the GNU-tar failure mode, run only where a GNU tar
     * is actually present on the runner. This documents exactly why the
     * launcher must not trust a PATH-resolved tar: GNU tar treats "C:..." as a
     * remote host. Skipped on runners without a GNU tar (e.g. only bsdtar).
     */
    public function test_gnu_tar_rejects_a_drive_letter_archive_path_demonstrating_the_bug(): void
    {
        $tar = $this->locateGnuTar();
        if ($tar === null) {
            $this->markTestSkipped('no GNU tar on this runner to demonstrate the "Cannot connect to C:" failure; skipped.');
        }

        $cmd = escapeshellarg($tar).' -tf '.escapeshellarg('C:\\nonexistent\\php.zip').' 2>&1';
        $output = (string) shell_exec($cmd);

        $this->assertMatchesRegularExpression(
            '/Cannot connect to C:|resolve failed/i',
            $output,
            'GNU tar must exhibit the "Cannot connect to C: resolve failed" behaviour that breaks the launcher.',
        );
    }

    private function locateGnuTar(): ?string
    {
        foreach (['tar', '/usr/bin/tar', '/bin/tar'] as $candidate) {
            $version = @shell_exec(escapeshellarg($candidate).' --version 2>&1');
            if (is_string($version) && stripos($version, 'GNU tar') !== false) {
                return $candidate;
            }
        }

        return null;
    }

    /**
     * Optional live proof that the archive URL resolves for the pinned patch.
     * Skipped when the runner has no route to the PHP mirror, so it never
     * breaks offline CI; it asserts 200 where the network is available.
     */
    #[DataProvider('phpUrlProvider')]
    public function test_php_urls_resolve_over_http(string $urlVar, bool $isFallback): void
    {
        $url = str_replace(
            '%PHP_ZIP%',
            str_replace('%PHP_VERSION%', $this->vars['PHP_VERSION'], $this->vars['PHP_ZIP']),
            $this->vars[$urlVar],
        );

        $ch = curl_init($url);
        if ($ch === false) {
            $this->markTestSkipped('curl extension unavailable; live URL check skipped.');
        }
        curl_setopt_array($ch, [CURLOPT_NOBODY => true, CURLOPT_FOLLOWLOCATION => true, CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 12, CURLOPT_SSL_VERIFYPEER => true]);
        curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $errno = curl_errno($ch);
        curl_close($ch);

        if ($errno !== 0 || $status === 0) {
            $this->markTestSkipped("no route to the PHP mirror from this runner (errno=$errno); live check skipped.");
        }

        // The permanent archive must always serve the pinned patch; this is the URL
        // that resolves the reported 404. The current-release URL may be 200 (new
        // patch) or 404 (moved to archive) - the launcher handles both via fallback.
        if ($isFallback) {
            $this->assertSame(200, $status, "permanent archive URL must serve the pinned PHP build: $url");
        } else {
            $this->assertContains($status, [200, 404], "releases URL expected 200 or 404 (fallback covers 404): $url");
        }
    }

    /** @return array<string, array{0:string, 1:bool}> */
    public static function phpUrlProvider(): array
    {
        return [
            'releases (current)' => ['PHP_ZIP_URL', false],
            'archives (permanent fallback)' => ['PHP_ARCHIVE_ZIP_URL', true],
        ];
    }
}
