#!/usr/bin/env python3
"""Fetch composer.lock dist archives via codeload (no packagist) and extract into vendor/.

Usage: vendor_fetch.py [--only a,b,c] [--fresh name...] [--limit N]
Resume-safe: skips packages whose vendor dir already holds a composer.json.
"""
import json, os, re, shutil, subprocess, sys, tarfile, zipfile

ROOT = '/home/user/TOEFL-House'
LOCK = os.path.join(ROOT, 'composer.lock')
VENDOR = os.path.join(ROOT, 'vendor')
CACHE = '/tmp/distcache'
os.makedirs(CACHE, exist_ok=True)

def org_repo(url):
    m = re.search(r'github\.com/([^/]+)/([^/]+?)(?:\.git)?$', url or '')
    return (m.group(1), m.group(2)) if m else (None, None)

def run(cmd, timeout=150):
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)

def fetch(url, dest):
    if os.path.exists(dest) and os.path.getsize(dest) > 1000:
        return True
    tmp = dest + '.part'
    r = run(['curl', '-sSL', '--retry', '3', '--retry-all-errors', '-m', '140', '-o', tmp, url])
    if r.returncode != 0 or not os.path.exists(tmp) or os.path.getsize(tmp) < 500:
        print(f'  DOWNLOAD FAIL rc={r.returncode} {url} :: {r.stderr.strip()[:160]}', flush=True)
        return False
    os.rename(tmp, dest)
    return True

def extract(archive, destdir):
    if os.path.exists(os.path.join(destdir, 'composer.json')):
        return True
    shutil.rmtree(destdir, ignore_errors=True)
    os.makedirs(destdir, exist_ok=True)
    if archive.endswith('.zip'):
        with zipfile.ZipFile(archive) as z:
            names = z.namelist()
            top = names[0].split('/')[0] if names else ''
            z.extractall(destdir)
            inner = os.path.join(destdir, top)
            if top and os.path.isdir(inner):
                for e in os.listdir(inner):
                    shutil.move(os.path.join(inner, e), destdir)
                os.rmdir(inner)
    else:
        with tarfile.open(archive, 'r:*') as t:
            members = t.getmembers()
            top = members[0].name.split('/')[0] if members else ''
            t.extractall(destdir)
            inner = os.path.join(destdir, top)
            if top and os.path.isdir(inner):
                for e in os.listdir(inner):
                    shutil.move(os.path.join(inner, e), destdir)
                try: os.rmdir(inner)
                except OSError: pass
    return os.path.exists(os.path.join(destdir, 'composer.json'))

def main():
    only, fresh, limit = set(), set(), 0
    args = sys.argv[1:]
    i = 0
    while i < len(args):
        if args[i] == '--only':
            only = set(args[i+1].split(',')); i += 2
        elif args[i] == '--fresh':
            fresh = set(args[i+1].split(',')); i += 2
        elif args[i] == '--limit':
            limit = int(args[i+1]); i += 2
        else:
            i += 1
    lock = json.load(open(LOCK))
    pkgs = lock['packages'] + lock.get('packages-dev', [])
    ok, fail, skipped = 0, [], 0
    for p in pkgs:
        name = p['name']
        if only and name not in only:
            continue
        if limit and (ok + len(fail)) >= limit:
            print(f'(limit {limit} reached; rerun to continue)')
            break
        dest = os.path.join(VENDOR, *name.split('/'))
        if name in fresh:
            shutil.rmtree(dest, ignore_errors=True)
        if os.path.exists(os.path.join(dest, 'composer.json')):
            skipped += 1
            continue
        src = p.get('source') or {}
        dist = p.get('dist') or {}
        ref = src.get('reference') or dist.get('reference')
        org, repo = org_repo(src.get('url') or '')
        if org and ref:
            durl = f'https://codeload.github.com/{org}/{repo}/tar.gz/{ref}'
            ext = 'tgz'
        elif dist.get('url'):
            durl = dist['url']
            ext = 'zip'
            org, repo = 'dist', name.replace('/', '-')
        else:
            fail.append(name + ' (no source)')
            continue
        cache = os.path.join(CACHE, f"{org}_{repo}_{(ref or 'dist')[:12]}.{ext}")
        print(f'{name} {p["version"]}', flush=True)
        if not fetch(durl, cache):
            fail.append(name + ' (download)')
            continue
        try:
            if extract(cache, dest):
                ok += 1
            else:
                fail.append(name + ' (extract: no composer.json)')
        except Exception as e:  # noqa: BLE001
            fail.append(f'{name} (extract: {e})')
    print(f'\nOK={ok} SKIPPED={skipped} FAIL={len(fail)}')
    for f in fail:
        print('FAILED:', f)

if __name__ == '__main__':
    main()
