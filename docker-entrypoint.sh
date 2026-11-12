#!/bin/sh
# Starts as root only to make the mounted folders usable, then runs the server as an ordinary user.
#
# The downloads folder is a folder of your computer (DOWNLOADS_DIR). When it already exists, the
# server runs as its owner, so saved files belong to you and the folder never needs opening up.
# When Docker had to create it, it is root's: it is handed to the image's own user (node).
set -eu

if [ "$(id -u)" != 0 ]; then
  exec "$@"
fi

uid=$(id -u node)
gid=$(id -g node)
dir=${DOWNLOADS_MOUNT:-}
if [ -n "$dir" ] && [ -d "$dir" ]; then
  owner=$(stat -c %u "$dir")
  if [ "$owner" = 0 ]; then
    chown "$uid:$gid" "$dir" 2>/dev/null || true
  else
    uid=$owner
    gid=$(stat -c %g "$dir")
  fi
fi

# The archive must belong to whoever the server runs as.
data=${DATA_DIR:-/data}
mkdir -p "$data"
if [ "$(stat -c %u "$data")" != "$uid" ]; then
  chown -R "$uid:$gid" "$data"
fi

exec setpriv --reuid="$uid" --regid="$gid" --clear-groups -- "$@"
