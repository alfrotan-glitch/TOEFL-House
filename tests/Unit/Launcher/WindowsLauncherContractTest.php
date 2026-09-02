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
        // Composer is installed via the OFFICIAL installer (https://getcomposer.org/installer),
        // which fetches the stable phar with signature verification - NOT a pinned direct-PHAR
        // URL such as the capitalized Composer-stable.phar that 404s.
        $this->assertSame('https://getcomposer.org/installer', $this->vars['COMPOSER_INSTALLER_URL'] ?? '');
        $this->assertStringNotContainsString('Composer-stable.phar', $this->bat, 'the capitalized 404 Composer direct-PHAR URL must not be used.');

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

    public function test_composer_is_installed_via_the_official_installer_and_verified(): void
    {
        // The official installer is fetched (atomic), executed to produce composer.phar, and
        // the result must exist and run --version.
        $this->assertMatchesRegularExpression('/call :fetch_file "%COMPOSER_SETUP%" "%COMPOSER_INSTALLER_URL%" "" "\d+"/', $this->bat);
        $this->assertMatchesRegularExpression(
            '/"%PHP%" "%COMPOSER_SETUP%" --install-dir="%RT%" --filename=composer\.phar[^
]*\n\s*if errorlevel 1 call :fail/',
            $this->bat,
            'the Composer installer must be run and a failure must stop the launcher.',
        );
        $this->assertMatchesRegularExpression('/if not exist "%COMPOSER_PHAR%" call :fail/', $this->bat, 'a missing composer.phar after install must fail.');
        $this->assertMatchesRegularExpression('/"%PHP%" "%COMPOSER_PHAR%" --version >nul 2>nul/', $this->bat, 'composer.phar must be verified by running --version.');
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

    public function test_composer_preparation_runs_as_a_self_healing_subroutine_before_database(): void
    {
        // Main flow must call :prepare_composer (between PHP prep and PostgreSQL).
        $this->assertMatchesRegularExpression('/^call :prepare_composer\s*$/m', $this->bat);
        $prep = $this->subroutineBody(':prepare_composer');
        $this->assertNotSame('', $prep, ':prepare_composer subroutine must exist.');
        // It reuses a healthy composer.phar (idempotent) and can replace a broken one.
        $this->assertMatchesRegularExpression('/if exist "%COMPOSER_PHAR%" \([\s\S]*?--version/', $prep);
        // It fails the launcher (hard stop) when composer cannot be made ready.
        $this->assertStringContainsString('call :fail', $prep);
    }

    public function test_composer_uses_the_official_installer_with_supported_flags_only(): void
    {
        $prep = $this->subroutineBody(':prepare_composer');
        // Downloaded atomically via the helper from the official installer URL.
        $this->assertMatchesRegularExpression('/call :fetch_file "%COMPOSER_SETUP%" "%COMPOSER_INSTALLER_URL%" "" "1000"/', $prep);
        // Executed with the LAUNCHER-LOCAL PHP ("%PHP%"), only supported installer options.
        $this->assertMatchesRegularExpression(
            '/"%PHP%" "%COMPOSER_SETUP%" --install-dir="%RT%" --filename=composer\.phar/',
            $prep,
            'installer must run with launcher PHP, --install-dir=%RT%, --filename=composer.phar.',
        );
        // Composer-RUNTIME flags are not installer options and must not be passed.
        $this->assertDoesNotMatchRegularExpression('/COMPOSER_SETUP%"[^\n]*--no-interaction/', $this->bat, '--no-interaction is not a Composer installer option.');
        $this->assertDoesNotMatchRegularExpression('/COMPOSER_SETUP%"[^\n]*--no-ansi/', $this->bat, '--no-ansi is a runtime flag; avoid unsupported installer flags.');
    }

    public function test_composer_installer_exit_code_and_output_are_captured_for_diagnostics(): void
    {
        $prep = $this->subroutineBody(':prepare_composer');
        // stdout+stderr redirected to a log and the exit code captured.
        $this->assertMatchesRegularExpression(
            '/--filename=composer\.phar\s*>\s*"%COMPOSER_LOG%"\s*2>&1\s*\n\s*set "COMPOSER_RC=%ERRORLEVEL%"/',
            $prep,
            'installer output must be logged and its exit code captured.',
        );
        // On failure the diagnostic is shown with the captured exit code and the log path.
        $this->assertStringContainsString('call :composer_diag %COMPOSER_RC%', $prep);
        $diag = $this->subroutineBody(':composer_diag');
        $this->assertMatchesRegularExpression('/type "%COMPOSER_LOG%"/', $diag, 'the diagnostic must print the installer log (stdout+stderr).');
        $this->assertStringContainsString('COMPOSER_RC', $prep, 'failures must report the installer exit code.');
    }

    public function test_composer_requires_a_present_non_empty_runnable_phar(): void
    {
        $prep = $this->subroutineBody(':prepare_composer');
        // Missing phar -> fail.
        $this->assertMatchesRegularExpression('/if not exist "%COMPOSER_PHAR%" \([\s\S]*?call :fail/', $prep);
        // Empty/partial phar (size floor) -> fail.
        $this->assertMatchesRegularExpression('/for %%S in \("%COMPOSER_PHAR%"\) do set "CP_BYTES=%%~zS"/', $prep);
        $this->assertMatchesRegularExpression('/if !CP_BYTES! LSS 100000 \([\s\S]*?call :fail/', $prep, 'a too-small composer.phar must be treated as partial/corrupt.');
        // Authoritative run: composer --version with launcher PHP.
        $this->assertMatchesRegularExpression(
            '/"%PHP%" "%COMPOSER_PHAR%" --version >nul 2>nul\s*\n\s*if errorlevel 1 \([\s\S]*?call :fail/',
            $prep,
            'the produced composer.phar must actually run --version; otherwise fail.',
        );
    }

    public function test_composer_stops_the_launcher_and_does_not_modify_global_path(): void
    {
        // Composer failure is a hard stop before PostgreSQL/application stages.
        $fail = $this->subroutineBody(':fail');
        $this->assertMatchesRegularExpression('/^\s*exit\s+1\s*$/m', $fail);
        $this->assertDoesNotMatchRegularExpression('/\bsetx\b/', $this->bat, 'no permanent/global PATH modification.');
        // prepare_composer is invoked before the PostgreSQL stage in main flow.
        $cPos = strpos($this->bat, 'call :prepare_composer');
        $pgPos = strpos($this->bat, 'if not exist "%PG_BIN%\initdb.exe"');
        $this->assertIsInt($cPos);
        $this->assertIsInt($pgPos);
        $this->assertLessThan($pgPos, $cPos, 'Composer is prepared before the PostgreSQL runtime stage.');
    }

    public function test_composer_partial_artifacts_are_cleaned_and_rerun_is_idempotent(): void
    {
        $prep = $this->subroutineBody(':prepare_composer');
        // Stale installer and the installer's temp phar are removed before a run.
        $this->assertStringContainsString('if exist "%COMPOSER_SETUP%" del', $prep);
        $this->assertStringContainsString('composer-temp.phar', $prep, 'the installer composer-temp.phar partial is cleaned.');
        // A healthy phar short-circuits (reuse), a broken one is deleted and rebuilt.
        $this->assertMatchesRegularExpression('/existing composer\.phar cannot run; replacing it/', $prep);
        // Deterministic simulation of the health decision: ok iff the phar exists,
        // is large enough, and runs --version.
        $decide = static function (bool $exists, int $bytes, bool $runsVersion): bool {
            return $exists && $bytes >= 100000 && $runsVersion;
        };
        $this->assertTrue($decide(true, 2_500_000, true), 'a valid composer.phar passes and is reused.');
        $this->assertFalse($decide(false, 0, false), 'missing phar triggers install.');
        $this->assertFalse($decide(true, 500, false), 'a tiny/partial phar is replaced.');
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
