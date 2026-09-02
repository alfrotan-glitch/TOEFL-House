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
        // Composer and Tailscale intentionally use rolling "latest/stable" pointers.
        $this->assertSame('https://getcomposer.org/Composer-stable.phar', $this->vars['COMPOSER_URL'] ?? '');
        $this->assertSame('https://download.tailscale.com/stable/tailscale-setup-latest.amd64.msi', $this->vars['TAILSCALE_MSI_URL'] ?? '');

        // PostgreSQL uses EDB's permanent binaries archive (pinned versions are retained
        // there indefinitely; this path does NOT move older patches the way PHP does).
        $this->assertStringStartsWith('https://get.enterprisedb.com/postgresql/', $this->vars['PG_ZIP_URL'] ?? '');
        $this->assertStringContainsString('binaries.zip', $this->vars['PG_ZIP_URL'] ?? '');
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
