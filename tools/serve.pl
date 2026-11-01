# A static file server, so the app can be driven in a real browser.
#
# There is no Node on this machine and Python is blocked by group policy,
# but Perl ships with Git for Windows - so this is the one thing here that
# can serve a directory. Core modules only, no CPAN.
#
#   perl tools/serve.pl [port]       (default 8120)
#
# It serves the project directory as-is; `dev.html` is the app with the
# local-storage adapter, which is how the UI gets walked without touching
# the published artifact's database.

use strict;
use warnings;
use IO::Socket::INET;
use Cwd qw(getcwd);

my $port = $ARGV[0] || 8120;

my %TYPE = (
  html => 'text/html; charset=utf-8',
  js   => 'text/javascript; charset=utf-8',
  css  => 'text/css; charset=utf-8',
  json => 'application/json; charset=utf-8',
  svg  => 'image/svg+xml',
  png  => 'image/png',
  jpg  => 'image/jpeg',
  ico  => 'image/x-icon',
  woff2 => 'font/woff2',
);

my $srv = IO::Socket::INET->new(
  LocalAddr => '127.0.0.1', LocalPort => $port,
  Proto => 'tcp', Listen => 16, ReuseAddr => 1
) or die "cannot listen on $port: $!\n";

$| = 1;
print "serving " . getcwd() . "\n";
print "  http://127.0.0.1:$port/dev.html\n";

while (my $c = $srv->accept) {
  my $line = <$c>;
  unless (defined $line) { close $c; next; }

  # Drain the headers; nothing here needs them.
  while (my $h = <$c>) { last if $h =~ /^\s*$/; }

  my ($method, $path) = $line =~ m{^(\w+)\s+(\S+)};
  $path = '/' unless defined $path;
  $path =~ s/\?.*$//;
  $path =~ s/%([0-9A-Fa-f]{2})/chr(hex($1))/ge;
  $path = '/dev.html' if $path eq '/';

  # Everything is served from the project directory and nowhere else.
  if ($path =~ /\.\./ || $path !~ m{^/}) {
    print $c "HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n";
    close $c; next;
  }

  my $file = substr($path, 1);
  if (!-f $file) {
    my $body = "not found: $path";
    print $c "HTTP/1.1 404 Not Found\r\n"
           . "Content-Type: text/plain\r\nContent-Length: " . length($body)
           . "\r\nConnection: close\r\n\r\n$body";
    close $c; next;
  }

  my ($ext) = $file =~ /\.([A-Za-z0-9]+)$/;
  my $type = $TYPE{lc($ext || '')} || 'application/octet-stream';

  open my $fh, '<:raw', $file or do { close $c; next; };
  local $/; my $body = <$fh>; close $fh;

  print $c "HTTP/1.1 200 OK\r\n"
         . "Content-Type: $type\r\n"
         . "Content-Length: " . length($body) . "\r\n"
         # Edited files must take effect on reload, every time.
         . "Cache-Control: no-store\r\n"
         . "Connection: close\r\n\r\n";
  print $c $body if ($method || '') ne 'HEAD';
  close $c;
}
