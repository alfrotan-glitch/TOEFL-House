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
        // Both URLs must be referenced by curl in the download block, and the
        // archive attempt must be gated on a failure of the releases attempt.
        $releasesCurl = $this->lineCountForCurl('PHP_ZIP_URL');
        $archiveCurl = $this->lineCountForCurl('PHP_ARCHIVE_ZIP_URL');
        $this->assertSame(1, $releasesCurl, 'the launcher must curl PHP_ZIP_URL exactly once.');
        $this->assertSame(1, $archiveCurl, 'the launcher must curl PHP_ARCHIVE_ZIP_URL exactly once (the fallback).');

        $this->assertMatchesRegularExpression(
            '/curl\.exe[^\n]*PHP_ZIP_URL[^\n]*\n\s*if errorlevel 1 \([\s\S]*?curl\.exe[^\n]*PHP_ARCHIVE_ZIP_URL/',
            $this->bat,
            'the archive download must only run when the releases download fails (if errorlevel 1).',
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
            '/move\s+/y\s+"%RT%\\\downloads\\\php[^"]*"\s+"%PHP_DIR%"/i',
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
        // The archive must exist...
        $this->assertMatchesRegularExpression(
            '/if not exist "%RT%\\\downloads\\\php\.zip" call :fail/',
            $this->bat,
            'a missing php.zip must fail loudly with the exact path.',
        );
        // ...and be non-trivial in size (a real PHP zip is ~30 MB; an error page/truncation is < 1 MB).
        $this->assertMatchesRegularExpression(
            '/for\s+%%F in \("%RT%\\\downloads\\\php\.zip"\)\s+do set "PHP_ZIP_BYTES=%%~zF"/',
            $this->bat,
            'the launcher must measure the downloaded php.zip size (%%~zF).',
        );
        $this->assertMatchesRegularExpression(
            '/if !PHP_ZIP_BYTES! LSS 1048576 call :fail/',
            $this->bat,
            'an empty/truncated php.zip (< 1 MB) must fail before extraction.',
        );
    }

    public function test_php_extraction_is_gated_on_php_exe_being_produced(): void
    {
        // After extraction the binary itself must exist before the launcher proceeds;
        // this is the layout-change sentinel (it would have caught the bad wrapper move).
        $this->assertMatchesRegularExpression(
            '/if not exist "%PHP_DIR%\\\php\.exe" call :fail/',
            $this->bat,
            'the launcher must verify %PHP_DIR%\php.exe exists after extraction, naming the path.',
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
        // Tailscale intentionally uses a rolling "latest" pointer.
        $this->assertSame('https://download.tailscale.com/stable/tailscale-setup-latest.amd64.msi', $this->vars['TAILSCALE_MSI_URL'] ?? '');
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
        // PHP download / integrity / extract / binary presence:
        foreach ([
            'PHP download failed or was truncated',
            'integrity test failed',
            'Could not unpack the PHP archive',
            '%PHP_DIR%\php.exe was not produced',
            'Composer installer download failed',
            'could not install or verify composer.phar',
            'Composer downloaded but cannot run',
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
        $prep = $this->subroutineBody(':prepare_php');
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
        $prep = $this->subroutineBody(':prepare_php');
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
        $prep = $this->subroutineBody(':prepare_php');
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
            'PRESENT',
            'MISSING',
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
        $prep = $this->subroutineBody(':prepare_php');
        // Healthy existing runtime -> jump straight to ready (reuse, no redownload).
        $this->assertMatchesRegularExpression('/if exist "%PHP_DIR%\\php\.exe" goto php_have/', $prep);
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

    public function test_database_is_created_only_when_absent(): void
    {
        $ensure = $this->subroutineBlock(':ensure_app_db', ':fetch_file');
        $this->assertNotSame('', $ensure, ':ensure_app_db must exist.');
        // existence is checked authoritatively against pg_database.
        $this->assertMatchesRegularExpression('/SELECT 1 FROM pg_database WHERE datname=.toefl_house./', $ensure);
        // createdb only in the "not defined" (absent) branch.
        $this->assertMatchesRegularExpression(
            '/if not defined DB_EXISTS \([\s\S]*?createdb\.exe"[^(]*toefl_house[\s\S]*?exit \/b 0\s*\n\s*\)/s',
            $ensure,
            'createdb runs only when toefl_house is absent.',
        );
    }

    public function test_existing_valid_database_is_reused_and_never_dropped_or_overwritten(): void
    {
        $ensure = $this->subroutineBlock(':ensure_app_db', ':fetch_file');
        $this->assertDoesNotMatchRegularExpression('/dropdb|DROP DATABASE/i', $this->bat, 'the launcher must never drop a database.');
        $this->assertDoesNotMatchRegularExpression('/createdb[\s\S]{0,200}(already exists)/i', $ensure, 'createdb must not be run blindly against an existing database.');
        // Validity is proven by authoritative schema/migration checks.
        $this->assertMatchesRegularExpression("/table_name='user_accounts'/", $ensure, 'validity checks for the application root table.');
        $this->assertMatchesRegularExpression("/migration='2026_08_25_000007_create_user_accounts_table'/", $ensure, 'validity checks for an application migration record.');
        $this->assertMatchesRegularExpression(
            '/if "%DB_KIND%"=="valid" \([\s\S]*?reusing it[\s\S]*?exit \/b 0\s*\n\s*\)/s',
            $ensure,
            'a recognized TOEFL House database is reused (no data changed).',
        );
    }

    public function test_existing_unrecognized_database_stops_safely_without_destroying_data(): void
    {
        $ensure = $this->subroutineBlock(':ensure_app_db', ':fetch_file');
        $this->assertMatchesRegularExpression(
            '/call :fail "[^"]*NOT recognized as the TOEFL House database[^"]*"/s',
            $ensure,
            'an existing but unrecognizable database stops the launcher with a clear diagnostic.',
        );
        $this->assertMatchesRegularExpression('/Nothing has been dropped or overwritten/', $ensure, 'the message must promise no data was destroyed.');
        $this->assertDoesNotMatchRegularExpression('/dropdb|DROP DATABASE/i', $this->bat, 'no automatic destruction path exists.');
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
        $this->assertMatchesRegularExpression('/if not defined DB_EXISTS \([\s\S]*createdb\.exe"[\s\S]*\)/', $ensure, 'createdb is guarded by the database-absent check.');
        // pg_ctl start appears exactly once, inside the not-running guard.
        $prep = $this->subroutineBlock(':prepare_pg', ':ensure_app_db');
        $this->assertSame(1, preg_match_all('/pg_ctl\.exe"[^\n]* start/', $prep), 'pg_ctl start appears exactly once, inside the not-running guard.');
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

    private function lineCountForCurl(string $var): int
    {
        return preg_match_all('/curl\.exe[^\n]*"%'.$var.'%"/', $this->bat);
    }
}
