# Build the standalone site that GitHub Pages serves.
#
# The Artifact runtime wraps index.html in a document skeleton before it
# serves it, so index.html on its own is a body fragment - it opens on
# <title> and never closes <body>. Anywhere else that is a broken page, so
# this reproduces the wrapper, exactly as dev.html does.
#
# The one difference from dev.html: no tools/shared-mode.js. That exists to
# make the local store behave like the shared one while testing, and a
# published page that deep-froze its own snapshots and delayed every write
# would be slower and no safer.
#
#   perl tools/mkpages.pl
#
# Core Perl only; there is no Node on this machine and Python is blocked.

use strict;
use warnings;
use File::Path qw(make_path);
use File::Copy qw(copy);

my $out = 'docs';

sub slurp {
  my $f = shift;
  open my $h, '<:raw', $f or die "$f: $!\n";
  local $/;
  my $t = <$h>;
  close $h;
  return $t;
}

sub spit {
  my ($f, $t) = @_;
  open my $h, '>:raw', $f or die "$f: $!\n";
  print $h $t;
  close $h;
}

make_path("$out/js") unless -d "$out/js";

my $head = slurp('tools/head.html');
my $body = slurp('index.html');
spit("$out/index.html", $head . $body . "\n</body></html>\n");

my $n = 0;
opendir my $d, 'js' or die "js: $!\n";
for my $f (sort grep { /\.js$/ } readdir $d) {
  copy("js/$f", "$out/js/$f") or die "js/$f: $!\n";
  $n++;
}
closedir $d;

# Jekyll is on by default for Pages and would skip anything beginning with
# an underscore. Nothing here does today, but a build that quietly drops a
# file is not a thing to leave to chance.
spit("$out/.nojekyll", '');

printf "docs/index.html  %d KB\ndocs/js/         %d files\n",
  int((-s "$out/index.html") / 1024), $n;
