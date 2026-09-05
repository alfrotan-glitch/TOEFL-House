<?php

declare(strict_types=1);

/*
 * Minimal composer-autoload-compatible dump generator.
 * Reads composer.json + composer.lock, writes vendor/autoload.php,
 * vendor/composer/{autoload_psr4,autoload_psr0,autoload_classmap,autoload_files}.php,
 * vendor/composer/{installed.json,installed.php}.
 * ClassLoader.php + InstalledVersions.php are copied from .sandbox/.
 */

const ROOT = '/home/user/TOEFL-House';
const VENDOR = ROOT.'/vendor';
const COMPOSER_DIR = VENDOR.'/composer';
const SANDBOX = ROOT.'/.sandbox';

function pkgComposerJson(string $dir): array
{
    $f = $dir.'/composer.json';
    $d = json_decode((string) @file_get_contents($f), true);
    return is_array($d) ? $d : [];
}

function normPaths(mixed $paths): array
{
    if (is_string($paths)) {
        return [$paths];
    }
    return is_array($paths) ? array_values($paths) : [];
}

function joinPaths(string $base, array $paths, ?string $targetDir = null): array
{
    $out = [];
    foreach ($paths as $p) {
        $full = rtrim($base, '/').'/'.ltrim($p, '/');
        if ($targetDir !== null && $targetDir !== '') {
            $full .= '/'.trim($targetDir, '/');
        }
        $out[] = $full;
    }
    return $out;
}

/** Token-based class finder for classmap rules (mirrors composer semantics). */
function findClasses(string $file): array
{
    $src = @file_get_contents($file);
    if ($src === false) {
        return [];
    }
    try {
        $tokens = token_get_all($src);
    } catch (Throwable) {
        return [];
    }
    $classes = [];
    $namespace = '';
    $nsDepth = 0;
    $depth = 0;
    $n = count($tokens);
    $prevSig = static function (int $i) use ($tokens): mixed {
        for ($j = $i - 1; $j >= 0; $j--) {
            $t = $tokens[$j];
            if (is_array($t) && in_array($t[0], [T_WHITESPACE, T_COMMENT, T_DOC_COMMENT], true)) {
                continue;
            }
            return $t;
        }
        return null;
    };
    for ($i = 0; $i < $n; $i++) {
        $t = $tokens[$i];
        if ($t === '{') {
            $depth++;
            continue;
        }
        if ($t === '}') {
            $depth--;
            if ($nsDepth > 0 && $depth < $nsDepth) {
                $namespace = '';
                $nsDepth = 0;
            }
            continue;
        }
        if (! is_array($t)) {
            continue;
        }
        [$id] = $t;
        if ($id === T_NAMESPACE) {
            $k = $i + 1;
            $name = '';
            for (; $k < $n; $k++) {
                $ct = $tokens[$k];
                if (is_array($ct) && in_array($ct[0], [T_WHITESPACE, T_COMMENT, T_DOC_COMMENT], true)) {
                    continue;
                }
                if (is_array($ct) && in_array($ct[0], [T_STRING, T_NAME_QUALIFIED, T_NAME_FULLY_QUALIFIED, T_NAME_RELATIVE], true)) {
                    $name .= $ct[1];
                    continue;
                }
                if ($ct === '\\' || (is_array($ct) && $ct[0] === T_NS_SEPARATOR)) {
                    $name .= '\\';
                    continue;
                }
                break;
            }
            if (str_starts_with($name, '\\')) {
                $name = substr($name, 1);
            }
            // `namespace\Foo` operator (followed by separator/::) is not a declaration.
            $after = null;
            for ($m = $k; $m < $n; $m++) {
                $ct = $tokens[$m];
                if (is_array($ct) && in_array($ct[0], [T_WHITESPACE, T_COMMENT, T_DOC_COMMENT], true)) {
                    continue;
                }
                $after = $ct;
                break;
            }
            if ($after === '{' || $after === ';') {
                $namespace = $name;
                $nsDepth = $after === '{' ? $depth + 1 : 0;
            }
            continue;
        }
        if (in_array($id, [T_CLASS, T_INTERFACE, T_TRAIT, T_ENUM], true)) {
            $prev = $prevSig($i);
            $prevId = is_array($prev) ? $prev[0] : null;
            if (in_array($prevId, [T_DOUBLE_COLON, T_OBJECT_OPERATOR, T_NULLSAFE_OBJECT_OPERATOR, T_NEW], true)) {
                continue; // ::class, ->, new X, anonymous classes
            }
            for ($j = $i + 1; $j < $n; $j++) {
                $nt = $tokens[$j];
                if (is_array($nt) && in_array($nt[0], [T_WHITESPACE, T_COMMENT, T_DOC_COMMENT], true)) {
                    continue;
                }
                if (is_array($nt) && $nt[0] === T_STRING) {
                    $classes[] = ltrim($namespace === '' ? $nt[1] : $namespace.'\\'.$nt[1], '\\');
                }
                break;
            }
        }
    }
    return $classes;
}

function scanClassmap(array $dirs, array $excludes): array
{
    $map = [];
    $it = function ($dir) use (&$map, $excludes) {
        if (is_file($dir)) {
            $files = [$dir];
        } else {
            $files = [];
            try {
                $rii = new RecursiveIteratorIterator(
                    new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS)
                );
            } catch (Throwable) {
                return;
            }
            foreach ($rii as $f) {
                /** @var SplFileInfo $f */
                if ($f->isFile() && str_ends_with($f->getFilename(), '.php')) {
                    $files[] = $f->getPathname();
                }
            }
        }
        foreach ($files as $file) {
            foreach ($excludes as $ex) {
                if ($ex !== '' && str_starts_with($file, $ex)) {
                    continue 2;
                }
            }
            foreach (findClasses($file) as $class) {
                if (! isset($map[$class])) {
                    $map[$class] = $file;
                }
            }
        }
    };
    foreach ($dirs as $d) {
        if ($d !== '' && (is_dir($d) || is_file($d))) {
            $it($d);
        }
    }
    ksort($map);
    return $map;
}

$root = pkgComposerJson(ROOT);
$lock = json_decode((string) file_get_contents(ROOT.'/composer.lock'), true);
$all = array_merge($lock['packages'], $lock['packages-dev'] ?? []);
$byName = [];
foreach ($all as $p) {
    $byName[$p['name']] = $p;
}

// Topological order by internal requires (deps first), root last.
$ordered = [];
$temp = [];
$visit = function ($name) use (&$visit, &$ordered, &$temp, $byName) {
    if (isset($ordered[$name]) || isset($temp[$name])) {
        return;
    }
    $temp[$name] = true;
    $reqs = array_merge(
        array_keys($byName[$name]['require'] ?? []),
        array_keys($byName[$name]['require-dev'] ?? [])
    );
    foreach ($reqs as $r) {
        if (isset($byName[$r])) {
            $visit($r);
        }
    }
    unset($temp[$name]);
    $ordered[$name] = true;
};
foreach (array_keys($byName) as $name) {
    $visit($name);
}

$psr4 = [];
$psr0 = [];
$files = [];
$classmap = [];

$collect = function (array $autoload, string $base) use (&$psr4, &$psr0, &$files, &$classmap) {
    foreach ((array) ($autoload['psr-4'] ?? []) as $ns => $paths) {
        foreach (joinPaths($base, normPaths($paths)) as $full) {
            $psr4[$ns][] = $full;
        }
    }
    foreach ((array) ($autoload['psr-0'] ?? []) as $ns => $paths) {
        $td = $autoload['target-dir'] ?? null;
        foreach (joinPaths($base, normPaths($paths), is_string($td) ? $td : null) as $full) {
            $psr0[$ns][] = $full;
        }
    }
    $excludes = [];
    foreach (normPaths($autoload['exclude-from-classmap'] ?? []) as $ex) {
        $excludes[] = rtrim($base, '/').'/'.ltrim($ex, '/');
    }
    $cmdirs = [];
    foreach (normPaths($autoload['classmap'] ?? []) as $cm) {
        $cmdirs[] = rtrim($base, '/').'/'.ltrim($cm, '/');
    }
    if ($cmdirs !== []) {
        foreach (scanClassmap($cmdirs, $excludes) as $c => $f) {
            if (! isset($classmap[$c])) {
                $classmap[$c] = $f;
            }
        }
    }
    foreach (normPaths($autoload['files'] ?? []) as $f) {
        $full = rtrim($base, '/').'/'.ltrim($f, '/');
        if (is_file($full)) {
            $files[] = $full;
        }
    }
};

foreach (array_keys($ordered) as $name) {
    $disk = pkgComposerJson(VENDOR.'/'.$name);
    $collect($disk['autoload'] ?? [], VENDOR.'/'.$name);
}
// Root package last.
$collect($root['autoload'] ?? [], ROOT);
$collect($root['autoload-dev'] ?? [], ROOT);

// Composer hard-adds its own runtime classes to the classmap.
$classmap['Composer\\Autoload\\ClassLoader'] = COMPOSER_DIR.'/ClassLoader.php';
$classmap['Composer\\InstalledVersions'] = COMPOSER_DIR.'/InstalledVersions.php';
// Longer prefixes first (composer convention).
uksort($psr4, static fn ($a, $b) => strlen($b) <=> strlen($a));
uksort($psr0, static fn ($a, $b) => strlen($b) <=> strlen($a));
ksort($classmap);

@mkdir(COMPOSER_DIR, 0777, true);
$var = static fn ($v) => '<?php return '.var_export($v, true).';'."\n";

file_put_contents(COMPOSER_DIR.'/autoload_psr4.php', $var($psr4));
file_put_contents(COMPOSER_DIR.'/autoload_psr0.php', $var($psr0));
file_put_contents(COMPOSER_DIR.'/autoload_classmap.php', $var($classmap));
$fileIds = [];
foreach (array_values(array_unique($files)) as $f) {
    $fileIds[hash('sha256', $f)] = $f;
}
file_put_contents(COMPOSER_DIR.'/autoload_files.php', $var($fileIds));
copy(SANDBOX.'/ClassLoader.php', COMPOSER_DIR.'/ClassLoader.php');
copy(SANDBOX.'/InstalledVersions.php', COMPOSER_DIR.'/InstalledVersions.php');

$autoloadPhp = <<<'PHP'
<?php

// Lazy-load the runtime classes (mirrors composer's autoload_real): tools
// like phpstan.phar declare their own copy first, and an eager require here
// would fatal with "Cannot declare class".
spl_autoload_register(static function ($class): void {
    if ($class === 'Composer\\Autoload\\ClassLoader') {
        require __DIR__.'/composer/ClassLoader.php';
    }
}, true, true);

$loader = new \Composer\Autoload\ClassLoader(__DIR__);

$map = require __DIR__.'/composer/autoload_psr4.php';
foreach ($map as $namespace => $paths) {
    $loader->setPsr4($namespace, $paths);
}
$map = require __DIR__.'/composer/autoload_psr0.php';
foreach ($map as $namespace => $paths) {
    $loader->set($namespace, $paths);
}
$loader->addClassMap(require __DIR__.'/composer/autoload_classmap.php');
$loader->register(true);

$files = require __DIR__.'/composer/autoload_files.php';
foreach ($files as $fileIdentifier => $file) {
    if (empty($GLOBALS['__composer_autoload_files'][$fileIdentifier])) {
        $GLOBALS['__composer_autoload_files'][$fileIdentifier] = true;
        require $file;
    }
}

return $loader;
PHP;
file_put_contents(VENDOR.'/autoload.php', $autoloadPhp."\n");

// installed.json (for artisan package:discover) + installed.php (for InstalledVersions).
$installedJson = ['packages' => []];
$versions = [];
foreach ($all as $p) {
    $e = $p;
    $e['install-path'] = '../'.$p['name'];
    $installedJson['packages'][] = $e;
    $v = [
        'pretty_version' => $p['version'],
        'version' => $p['version'],
        'reference' => $p['source']['reference'] ?? $p['dist']['reference'] ?? null,
        'type' => $p['type'] ?? 'library',
        'install_path' => __DIR__.'/../'.$p['name'],
        'aliases' => [],
        'dev_requirement' => false,
    ];
    if (isset($p['replace'])) {
        $v['replaced'] = array_values((array) $p['replace']);
    }
    if (isset($p['provide'])) {
        $v['provided'] = array_values((array) $p['provide']);
    }
    $versions[$p['name']] = $v;
}
foreach ($lock['packages-dev'] ?? [] as $p) {
    if (isset($versions[$p['name']])) {
        $versions[$p['name']]['dev_requirement'] = true;
    }
    foreach ($installedJson['packages'] as &$e) {
        if ($e['name'] === $p['name']) {
            $e['dev-requirement'] = true;
        }
    }
    unset($e);
}
file_put_contents(COMPOSER_DIR.'/installed.json', json_encode($installedJson, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
$rootName = $root['name'] ?? 'toefl-house/toefl-house';
$installedPhp = [
    'root' => [
        'name' => $rootName,
        'pretty_version' => '1.0.0+no-version-set',
        'version' => '1.0.0.0',
        'reference' => null,
        'type' => 'project',
        'install_path' => __DIR__.'/../../',
        'aliases' => [],
        'dev' => true,
    ],
    'versions' => array_merge([$rootName => [
        'pretty_version' => '1.0.0+no-version-set',
        'version' => '1.0.0.0',
        'reference' => null,
        'type' => 'project',
        'install_path' => __DIR__.'/../../',
        'aliases' => [],
        'dev_requirement' => false,
    ]], $versions),
];
file_put_contents(COMPOSER_DIR.'/installed.php', '<?php return '.var_export($installedPhp, true).';'."\n");

echo 'psr4='.count($psr4).' psr0='.count($psr0).' classmap='.count($classmap).' files='.count($fileIds).' packages='.count($all).PHP_EOL;
