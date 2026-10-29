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
# Usage: perl tools/port-workflows.pl [--check | --verify-patches]
#
# Every mode first points this clone's core.hooksPath at .githooks (see
# .githooks/install), because git cannot install a hook at clone time. It is a
# no-op — and silent — when the clone is already configured, and it is skipped
# under CI, where nothing is committed.
#   --check           write nothing; exit non-zero if any root file differs from
#                     what this would write
#   --verify-patches  write nothing; check only the hand patches under apps/.
#                     This is what .githooks/pre-commit runs, so a reverted
#                     patch cannot enter a commit at all.
#
# Every mode exits non-zero when a hand patch under apps/ is missing, so a
# re-import cannot be mistaken for a clean regeneration: the root copies are
# still written in the default mode (the tree stays consistent), but the run
# reports failure and says the regenerated files are not safe to commit.
# ═══════════════════════════════════════════════════════════════════════════

use strict;
use warnings;
use File::Basename qw(basename dirname);
use File::Find      ();
use File::Path      qw(make_path);

my $CHECK  = grep { $_ eq '--check' } @ARGV;
my $VERIFY = grep { $_ eq '--verify-patches' } @ARGV;

# ── Keep this clone's guard installed ──────────────────────────────────────
# core.hooksPath is per-clone config, so git cannot carry it: a fresh clone
# starts with no pre-commit hook, and the patch claims are then checked only
# after the commit is pushed. Anyone who regenerates workflows is exactly who
# can commit a reverted patch, so every mode repairs the clone first. The
# installer says nothing when the clone is already correct, which is what lets
# the hook's own --verify-patches path call it without paying for it.
if (!$ENV{CI} && -f '.githooks/install') {
    my $out = `sh .githooks/install --quiet 2>&1`;
    my $rc  = $? >> 8;
    if ($rc) {
        warn $out if defined $out && length $out;
        warn "  (the pre-commit guard is not active in this clone; run .githooks/install)\n";
    }
    elsif (defined $out && length $out) {
        print $out;
    }
}

# ── The test surface of each app ────────────────────────────────────────────
# One entry per workflow that runs tests, lints, or static analysis. Anything
# that ships something (release.yml, docker-publish.yml, npm-publish.yml,
# pages.yml, deploy-*.yml) is intentionally absent; see the header.
my %SEED = (
    'cantus'          => [qw(ci.yml)],
    'cantus-gateway'  => [qw(ci.yml)],
    'cantus-switch'   => [qw(ci.yml)],
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
        # A step's `run:` sits at column 8 (or 6 behind a `- `). A job-level
        # `defaults: { run: ... }` also has a `run:` key, at column 6, and
        # inserting a sibling there would make `defaults` invalid rather than
        # working-directory the step.
        if ($in_jobs && !$seen && $line =~ /^( {8,})run:/) {
            push @out, "$1" . 'working-directory: .';
        }
        push @out, $line;
    }
    return join("\n", @out);
}

# ── Hand patches under apps/, and how to know they survived a re-import ────
# Three files in apps/ carry a hand fix: two composite actions locate their
# project from their own path, because an action's steps run at the workspace
# root no matter what the calling workflow's working-directory says, and
# capstone's CI installs the test runner its switch tests need.
#
# All three live under apps/, which is the upstream project's own tree, so a
# re-import from the standalone repository overwrites them. That is the quiet
# case: the revert produces no diff in the generated output at all, because the
# root copy is faithfully regenerated from the reverted source and stays "in
# sync" while the breakage the patch existed to fix comes back. Nothing else in
# CI would notice, which is why the check lives here. Each entry is a claim
# about the file that must still hold:
#
#   marker  the comment the patch carries, so a revert is detectable at all
#   needs   a pattern the fix depends on (optional)
#   bans    the pre-fix form, which must not come back (optional)
#   breaks  what goes wrong when the claim fails, in the operator's terms
my @PATCHED = (
    {
        path   => 'apps/omniroute/.github/actions/npm-ci-retry/action.yml',
        breaks => 'every job that installs through it runs npm at the repository root',
    },
    {
        path   => 'apps/rea/.github/actions/portable-build-cache/action.yml',
        breaks => 'the cache probe and build scripts resolve against the monorepo root',
    },
    {
        path   => 'apps/capstone/.github/workflows/ci.yml',
        needs  => qr/python3 -m pytest pbx\/tests/,
        bans   => qr/python3 -m unittest discover -s pbx\/tests/,
        breaks => 'the switch tests collect nothing and the job passes while running none',
    },
);

# The entries whose claims no longer hold.
sub check_patches {
    my @out;
    for my $fix (@PATCHED) {
        my $p = $fix->{path};
        next unless -f $p;
        open my $fh, '<', $p or next;
        local $/;
        my $t = <$fh>;
        close $fh;

        my @why;
        push @why, 'the monorepo-port marker is gone' unless $t =~ /monorepo-port:/;
        push @why, 'the patched command is gone' if $fix->{needs} && $t !~ $fix->{needs};
        push @why, 'the pre-fix form is back'    if $fix->{bans}  && $t =~ $fix->{bans};
        next unless @why;

        push @out, { path => $p, why => [@why], breaks => $fix->{breaks} };
    }
    return @out;
}

# A missing patch is a failure in every mode, never a warning: nothing
# downstream can catch it, because the regenerated copy matches the reverted
# source exactly and a later `--check` sees a clean tree.
sub report_missing {
    my ($mode, @broken) = @_;
    return unless @broken;

    my $bar = '=' x 77;
    warn "\n$bar\n";
    warn sprintf("FAILED: %d monorepo patch%s missing under apps/\n",
        scalar(@broken), @broken == 1 ? '' : 'es');
    warn "\n";
    warn "A re-import from upstream overwrites these files, and that revert leaves no\n";
    warn "diff in the generated workflows: they are regenerated from the reverted\n";
    warn "source and still match it. Restore the patch before committing here.\n";
    warn "\n";
    warn $mode eq 'check'  ? "Nothing was written (--check).\n"
       : $mode eq 'verify' ? "Nothing was written (--verify-patches). The commit is blocked.\n"
       : "The root copies just written were regenerated from the reverted sources and\n"
       . "are NOT safe to commit on their own.\n";
    warn "\n";
    for my $b (@broken) {
        warn "  $b->{path}\n";
        warn "      lost:  " . join('; ', @{ $b->{why} }) . "\n";
        warn "      costs: $b->{breaks}\n";
        warn "      fix:   git log -p -- $b->{path}\n";
    }
    warn "$bar\n";
}

# Claims only: no writes, no regeneration, no staleness. This is the hook's
# entry point, so it must stay fast and must never touch the tree.
if ($VERIFY) {
    my @broken = check_patches();
    report_missing('verify', @broken);
    exit 1 if @broken;
    print "monorepo patches: intact\n";
    exit 0;
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

my @broken = check_patches();

printf "%d workflow(s) ported\n", scalar @order;

report_missing($CHECK ? 'check' : 'write', @broken);

exit((@broken || ($CHECK && $changed)) ? 1 : 0);
