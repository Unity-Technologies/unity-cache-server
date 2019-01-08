#!/usr/bin/env sh

# run to set up the cache server launch daemons
# if the bootstrap/kickstart commands fail, use the commented load -w instead

sudo bash -c "
for file in local.UnityCacheServer.KeepAlive.plist \
            local.UnityCacheServer.PurgeStdErr.plist \
            local.UnityCacheServer.PurgeStdOut.plist \
            local.UnityCacheServer.NightlyRestart.plist \
            local.UnityCacheServer.CacheCleanup.plist
  mv \$file /Library/LaunchDaemons
  chown root:wheel /Library/LaunchDaemons/\$file
  launchctl bootout system /Library/LaunchDaemons/\$file 2>/dev/null
  launchctl bootstrap system /Library/LaunchDaemons/\$file
  launchctl kickstart system/\${file/.plist}
  # launchctl load -w /Library/LaunchDaemons/\$file
done
sudo launchctl list | grep local.UnityCacheServer"

# Output should look something like this:
# 
# From left to right, the PID, if the service is running, the last exit code or, if negative, the signal used to terminate the process, and the label.
# -      0    local.UnityCacheServer.CacheCleanup
# 457    0    local.UnityCacheServer.KeepAlive
# -      0    local.UnityCacheServer.NightlyRestart
# -      0    local.UnityCacheServer.PurgeStdErr
# -      0    local.UnityCacheServer.PurgeStdOut
