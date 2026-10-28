#!/usr/bin/env perl
# ═══════════════════════════════════════════════════════════════════════════
# port-workflows.pl — lift each app's CI workflows into the monorepo root.
#
# GitHub reads workflows only from <repo>/.github/workflows, so the copies that
# live in apps/<app>/.github/workflows have never run since the import. This
# script regenerates the root copies from them, adjusting only what the extra
# directory level changes:
#
#   * push/pull_request gain a path filter on apps/<app>/**, so a push that
#     touches one app does not start thirteen pipelines;
#   * every job runs with working-directory apps/<app>, so the relative paths
#     the workflow was written against (npm ci, prove -Ilib, git ls-files)
#     still resolve;
#   * ./ references to local actions and reusable workflows move with it;
#   * ${{ github.workspace }} gains the /apps/<app> suffix, because the
#     workspace is now the monorepo root rather than the app;
#   * concurrency groups are prefixed, so two apps' runs cannot cancel
#     each other.
#
# Release, publish, deploy, and Pages workflows are deliberately NOT ported:
# in a monorepo a push to main would publish thirteen artefacts instead of one.
# They stay in apps/<app>/.github/workflows as documentation of each project's
# release process, and the README says so.
#
# Usage: perl tools/port-workflows.pl [--check]
#   --check  exit non-zero if any root file differs from what this would write
# ═══════════════════════════════════════════════════════════════════════════

use strict;
use warnings;
use File::Basename qw(basename dirname);
use File::Find      ();
use File::Path      qw(make_path);

my $CHECK = grep { $_ eq '--check' } @ARGV;

# ── The test surface of each app ────────────────────────────────────────────
# One entry per workflow that runs tests, lints, or static analysis. Anything
# that ships something (release.yml, docker-publish.yml, npm-publish.yml,
# pages.yml, deploy-*.yml) is intentionally absent; see the header.
my %SEED = (
    'cantus'          => [qw(ci.yml)],
    'capstone'        => [qw(ci.yml)],
    'claude-mem'      => [qw(ci.yml ods-native.yml windows.yml)],
    'dograh'          => [qw(api-tests.yml pre-pr-drift-check.yml)],
    'freebuff'        => [qw(ci.yml)],
    'genie-soulforge' => [qw(ci.yml)],
    'omniroute'       => [qw(ci.yml)],
    'ontrak'          => [qw(ci.yml)],
    'ontrak-mcp'      => [qw(ci.yml)],
    'opensms-android' => [qw(ci.yml)],
    'rea'             => [qw(ci.yml)],
    'telno'           => [qw(ci.yml)],
    'webmail'         => [qw(ci.yml tests.yml perf-guard.yml)],
);

# ── Locate the repo root (this script lives in tools/) ──────────────────────
my $ROOT = dirname(dirname($0));
$ROOT = '.' if $ROOT eq '';
chdir $ROOT or die "chdir $ROOT: $!\n";

my $OUTDIR = '.github/workflows';
make_path($OUTDIR) unless -d $OUTDIR;

sub src_path { my ($app, $file) = @_; return "apps/$app/.github/workflows/$file" }
sub out_name { my ($app, $file) = @_; return "$app-$file" }

# ── Resolve the port set, following reusable-workflow references ────────────
# A ported ci.yml that calls `uses: ./.github/workflows/real-browser.yml` needs
# that file reachable at its new path, or the run fails at parse time. Close
# over those references so the set is self-contained.
my (%want, @order);
my @queue = map { my $a = $_; map { [ $a, $_ ] } @{ $SEED{$a} } } sort keys %SEED;
while (@queue) {
    my ($app, $file) = @{ shift @queue };
    next if $want{"$app/$file"};
    my $src = src_path($app, $file);
    next unless -f $src;    # cross-repo reference; nothing to port
    $want{"$app/$file"} = 1;
    push @order, [ $app, $file ];

    open my $fh, '<', $src or die "$src: $!\n";
    local $/;
    my $text = <$fh>;
    close $fh;
    while ($text =~ m{ uses:\s*\./\.github/workflows/([A-Za-z0-9._-]+\.ya?ml)}g) {
        push @queue, [ $app, $1 ];
    }
}

# ── Transforms ─────────────────────────────────────────────────────────────

sub indent_of { my ($l) = @_; return length($1) if $l =~ /^(\s*)/; return 0 }

# Prefix a path so it still points inside the app from the monorepo root.
sub app_rel {
    my ($v, $app) = @_;
    return $v if $v =~ m{^(?:/|~|apps/|\$\{\{|'|\"|\.\.)};
    return $v if $v =~ /\$\{\{\s*github\.workspace/;
    return "apps/$app/$v";
}

# Rewrite the `on:` block: add or extend a path filter for this app.
sub rewrite_triggers {
    my ($text, $app, $file) = @_;
    my @l = split /\n/, $text, -1;
    my $start = -1;
    for my $i (0 .. $#l) { if ($l[$i] =~ /^on:\s*$/) { $start = $i; last } }
    return $text if $start < 0;    # reusable (workflow_call only) or already ported

    my $end = scalar @l;
    for my $i ($start + 1 .. $#l) { if ($l[$i] =~ /^\S/) { $end = $i; last } }

    my $newfile = out_name($app, $file);
    my @out = @l[ 0 .. $start ];
    my $i = $start + 1;
    while ($i < $end) {
        my $line = $l[$i];
        if ($line =~ /^  (push|pull_request):\s*$/) {
            push @out, $line;
            # Collect this trigger's children (indented 4+), skipping blanks.
            my $j = $i + 1;
            my @kids;
            while ($j < $end) {
                my $k = $l[$j];
                last if $k =~ /^\S/ || $k =~ /^  \S/;    # next trigger
                push @kids, $k;
                $j++;
            }
            my $has_paths = grep { /^    paths(-ignore)?:/ } @kids;
            if ($has_paths) {
                my $in_list = 0;
                for my $k (@kids) {
                    # Flow style: paths: ['a/**', 'b/**'] on one line.
                    if ($k =~ /^(    (?:paths|paths-ignore):\s*)\[(.*)\]\s*$/) {
                        my ($head, $list) = ($1, $2);
                        my @items = split /,\s*/, $list;
                        for my $it (@items) {
                            next unless $it =~ /^(["']?)(.+?)\1$/;
                            my ($q, $v) = ($1, $2);
                            $it = $q . map_path_value($v, $app, $file, $newfile) . $q;
                        }
                        push @out, $head . '[' . join(', ', @items) . ']';
                        next;
                    }
                    if ($k =~ /^    paths(-ignore)?:/) { $in_list = 1; push @out, $k; next }
                    if ($in_list && $k =~ /^\s{6,}- /) {
                        push @out, map_path_item($k, $app, $file, $newfile);
                        next;
                    }
                    $in_list = 0 if $k =~ /^    \S/;
                    push @out, $k;
                }
            } else {
                push @out, '    paths:';
                push @out, '      - "apps/' . $app . '/**"';
                push @out, '      - ".github/workflows/' . $newfile . '"';
                push @out, @kids;
            }
            $i = $j;
            next;
        }
        push @out, $line;
        $i++;
    }
    push @out, @l[ $end .. $#l ] if $end <= $#l;
    return join("\n", @out);
}

# A trigger-filter path: point it at the app, or at the workflow's own new
# location. Negative patterns (!foo) are left alone: their meaning is relative
# to the whole path set, not to the entry they sit on.
sub map_path_value {
    my ($val, $app, $file, $newfile) = @_;
    return ".github/workflows/$newfile" if $val eq ".github/workflows/$file";
    return $val if $val =~ m{^(?:!|apps/)};
    $val =~ s{^\./}{};
    return "apps/$app/$val";
}

# A path item in a trigger filter: keep its quoting and trailing comment.
sub map_path_item {
    my ($line, $app, $file, $newfile) = @_;
    return $line unless $line =~ /^(\s*- )(["']?)(.+?)\2(\s*#.*)?$/;
    my ($lead, $q, $val, $tail) = ($1, $2, $3, $4 // '');
    if ($val eq ".github/workflows/$file") {
        return "$lead$q.github/workflows/$newfile$q$tail";
    }
    my $new = map_path_value($val, $app, $file, $newfile);
    return $lead . $q . $new . $q . $tail;
}

# hashFiles('a', 'b/**') -> hashFiles('apps/x/a', 'apps/x/b/**'), leaving
# absolute patterns, workflow expressions and already-prefixed ones alone.
sub hash_files {
    my ($args, $app, $already) = @_;
    my @out;
    for my $arg (split /,\s*/, $args) {
        if ($arg =~ /^(["'])(.+?)\1$/) {
            my ($q, $p) = ($1, $2);
            $p = "apps/$app/$p" unless $p =~ $already;
            $arg = "$q$p$q";
        }
        push @out, $arg;
    }
    return 'hashFiles(' . join(', ', @out) . ')';
}

sub transform {
    my ($text, $app, $file) = @_;

    $text =~ s/\r\n/\n/g;

    # Generated banner + namespaced workflow name.
    my $orig_name = 'workflow';
    if ($text =~ /^name:\s*['"]?(.+?)['"]?\s*$/m) { $orig_name = $1 }
    my $banner = <<"BANNER";
# ═══════════════════════════════════════════════════════════════════════════
# GENERATED FILE — edit the source, not this copy.
#
#   source:      apps/$app/.github/workflows/$file
#   regenerate:  perl tools/port-workflows.pl
#
# The copy exists because GitHub only reads workflows from the repository root.
# This one runs only when apps/$app/** changes.
# ═══════════════════════════════════════════════════════════════════════════
BANNER

    my $name = "$app: $orig_name";
    if ($text =~ /^name:.*$/m) {
        $text =~ s/^name:.*$/name: "$name"/m;
    } else {
        $text = "name: \"$name\"\n" . $text;
    }
    $text = $banner . "\n" . $text;

    $text = rewrite_triggers($text, $app, $file);

    # Local actions and reusable workflows move down with the app. Reusable
    # workflows are renamed to <app>-<file> in this directory, so they map to
    # their ported name; local actions keep their path under the app.
    $text =~ s{uses:\s*\./\.github/workflows/([A-Za-z0-9._-]+\.ya?ml)}
              {uses: ./.github/workflows/$app-$1}g;
    $text =~ s{uses:\s*\./(?!\.github/workflows/)([^\s#]+)}{uses: ./apps/$app/$1}g;

    # The checkout is at the monorepo root now; anything the workflow asked for
    # relative to the workspace has to say which app it means.
    $text =~ s{(\$\{\{\s*github\.workspace\s*\}\})(?!/apps/)}{$1/apps/$app}g;

    # Step and job-level directories, plus the path-like action inputs that are
    # resolved against the workspace rather than the step's directory.
    my @l = split /\n/, $text, -1;
    my $block = block_scalar_lines(\@l);
    my $PATHLIKE = qr/(?:working-directory|path|context|cache-dependency-path|bun-version-file|node-version-file|version-file)/;
    my $ALREADY  = qr{^(?:/|~|apps/|\$\{|!)|github\.workspace};
    for (my $i = 0; $i < @l; $i++) {
        next if $block->[$i];    # a script body is not YAML, leave it alone
        if ($l[$i] =~ /^(\s+)($PATHLIKE):\s*([|>][-+]?)\s*$/) {
            # Block scalar: every line under it is a path, cache glob, or file.
            my ($ind, $key) = ($1, $2);
            my $j = $i + 1;
            while ($j < @l) {
                if ($l[$j] =~ /^(\s*)\S/) {
                    last if length($1) <= length($ind);    # dedented: block ended
                    $l[$j] =~ /^(\s+)(\S.*?)\s*$/ or next;
                    $l[$j] = "$1apps/$app/$2" unless $2 =~ $ALREADY;
                }
                $j++;
            }
            next;
        }
        next unless $l[$i] =~ /^(\s+)($PATHLIKE):\s*(\S.*?)\s*$/;
        my ($ind, $key, $val) = ($1, $2, $3);
        next if $val =~ $ALREADY;
        next if $val =~ /\s#/;    # trailing comment: we cannot tell where the value ends
        $l[$i] = "$ind$key: " . "apps/$app/$val";
    }

    # setup-node/setup-python resolve `cache:` against the workspace root and
    # FAIL (not warn) when the lockfile is not there, so every cache request
    # has to name the app's lockfile explicitly. This is the one rewrite the
    # port cannot skip: without it every npm job dies in "Set up Node".
    my %LOCK = (
        npm  => 'package-lock.json',
        yarn => 'yarn.lock',
        pnpm => 'pnpm-lock.yaml',
        pip  => 'requirements.txt',
    );
    for (my $i = 0; $i < @l; $i++) {
        next if $block->[$i];
        next unless $l[$i] =~ /^(\s+)cache:\s*(npm|yarn|pnpm|pip)\s*$/;
        my ($ind, $pm) = ($1, $2);
        my ($j, $has) = ($i + 1, 0);
        while ($j < @l) {
            # A sibling at the same indent is still part of this `with:` block,
            # so look for the key before deciding the block has ended.
            $has = 1 if $l[$j] =~ /^\s+cache-dependency-path:/;
            if ($l[$j] =~ /^(\s*)\S/ && $l[$j] !~ /^\s*#/) {
                last if length($1) <= length($ind);
            }
            $j++;
        }
        next if $has;
        my $lock = $LOCK{$pm};
        if (-e "apps/$app/$lock") {
            splice @l, $i + 1, 0, "${ind}cache-dependency-path: apps/$app/$lock";
            $i++;
        } else {
            # Caching is impossible without a lockfile, and asking for it is a
            # build failure rather than a slow build, so ask for nothing.
            $l[$i] = "$ind# cache: $pm dropped by tools/port-workflows.pl — no $lock in apps/$app";
        }
    }

    # hashFiles() globs from the workspace root, so its relative patterns need
    # the app prefix for the same reason every other path does -- otherwise the
    # cache key hashes an empty set and every build misses.
    $text = join("\n", @l);
    $text =~ s{hashFiles\((.*?)\)}{hash_files($1, $app, $ALREADY)}gse;

    # Two apps' runs must not cancel each other.
    $text =~ s/^(\s+group:\s*)(.+)$/$1 . "$app-" . $2/gme;

    # Every job runs inside the app.
    unless ($text =~ /^defaults:/m) {
        my $block = "defaults:\n  run:\n    working-directory: apps/$app\n";
        if ($text =~ /^env:/m) {
            $text =~ s/^env:/$block\nenv:/m;
        } elsif ($text =~ /^permissions:/m) {
            $text =~ s/^permissions:/$block\npermissions:/m;
        } else {
            $text =~ s/^(?=jobs:)/$block\n/m;
        }
    }

    $text = fix_precheckout_steps($text);

    $text =~ s/\n{3,}/\n\n/g;
    $text .= "\n" unless $text =~ /\n\z/;
    return $text;
}

# Mark every line that is the body of a block scalar (`run: |`, `with: >`,
# `paths: |` ...). Those lines are data, not YAML: a shell script is allowed to
# contain `path: something` or a bare `run:`, and rewriting it would corrupt it.
sub block_scalar_lines {
    my ($l) = @_;
    my @in = (0) x @$l;
    my $ind;
    for my $i (0 .. $#$l) {
        if (defined $ind) {
            if ($l->[$i] =~ /^(\s*)\S/ && length($1) <= $ind) { undef $ind }
            else { $in[$i] = 1; next }
        }
        if ($l->[$i] =~ /^(\s*)[^\s#].*?:\s*[|>][-+]?\s*$/) { $ind = length($1) }
    }
    return \@in;
}

# The runner creates the step's process in `defaults.run.working-directory`
# *before* the step runs, so a step that runs before actions/checkout dies with
# "could not start process: no such file or directory" -- the app directory is
# not on disk yet. Steps that precede the job's checkout get an explicit `.`,
# which is the directory the original workflow ran them from.
sub fix_precheckout_steps {
    my ($text) = @_;
    my @l = split /\n/, $text, -1;
    my $block = block_scalar_lines(\@l);
    my (@out, $in_jobs, $seen);
    for my $i (0 .. $#l) {
        my $line = $l[$i];
        if ($block->[$i]) { push @out, $line; next }
        if ($line =~ /^jobs:\s*$/) { $in_jobs = 1; $seen = 0; push @out, $line; next }
        if ($in_jobs && $line =~ /^  [A-Za-z0-9_-]+:\s*$/) { $seen = 0; push @out, $line; next }
        if ($in_jobs && $line =~ /uses:\s*actions\/checkout/) { $seen = 1; push @out, $line; next }
        if ($in_jobs && !$seen && $line =~ /^(\s*)run:/) {
            push @out, "$1" . 'working-directory: .';
        }
        push @out, $line;
    }
    return join("\n", @out);
}

# ── Write ──────────────────────────────────────────────────────────────────
my $changed = 0;
my %expected;
for my $pair (@order) {
    my ($app, $file) = @$pair;
    my $src = src_path($app, $file);
    open my $fh, '<', $src or die "$src: $!\n";
    local $/;
    my $text = <$fh>;
    close $fh;

    my $out  = transform($text, $app, $file);
    my $dest = "$OUTDIR/" . out_name($app, $file);
    $expected{$dest} = $out;

    my $old = '';
    if (-f $dest) {
        open my $oh, '<', $dest or die "$dest: $!\n";
        local $/; $old = <$oh>; close $oh;
        $old =~ s/\r\n/\n/g;    # the checkout may be CRLF; that is not a difference
    }
    next if $old eq $out;

    if ($CHECK) {
        warn "stale: $dest\n";
        $changed = 1;
        next;
    }
    open my $oh, '>', $dest or die "$dest: $!\n";
    print {$oh} $out;
    close $oh;
    print "wrote $dest\n";
    $changed = 1;
}

# A ported workflow whose source disappeared must not linger.
for my $dest (glob("$OUTDIR/*.yml")) {
    next if $expected{$dest};
    next unless -f $dest;
    open my $fh, '<', $dest or next;
    local $/;
    my $t = <$fh>;
    close $fh;
    next unless $t =~ /^# GENERATED FILE — edit the source, not this copy\./m;
    if ($CHECK) { warn "orphan: $dest\n"; $changed = 1; next }
    unlink $dest or die "unlink $dest: $!\n";
    print "removed $dest\n";
    $changed = 1;
}

# Two composite actions locate their project from their own path, because a
# composite action's steps run at the workspace root no matter what the calling
# workflow's working-directory says. That patch lives in the app's file, so a
# re-import can drop it and every job that installs through them would fail at
# the first step. Warn rather than fail: the workflows are still correct, and
# the fix is three lines in the two files named below.
my @PATCHED = (
    'apps/omniroute/.github/actions/npm-ci-retry/action.yml',
    'apps/rea/.github/actions/portable-build-cache/action.yml',
);
for my $p (@PATCHED) {
    next unless -f $p;
    open my $fh, '<', $p or next;
    local $/;
    my $t = <$fh>;
    close $fh;
    next if $t =~ /monorepo-port:/;
    warn "WARNING: $p lost its monorepo-port patch; jobs that use it will run\n"
       . "         at the repository root and fail. Re-apply the `cd` (see git log).\n";
    $changed = 1 if $CHECK;
}

printf "%d workflow(s) ported\n", scalar @order;
exit($CHECK && $changed ? 1 : 0);
