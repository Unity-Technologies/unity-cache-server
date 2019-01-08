# macOS launchd property files

## Settings to change locally

* launchd property files cannot reference environment variables, so paths need to be absolute.
* Change the UserName and GroupName values as appropriate on your system.
* Set the log-level as desired.
* Set the number of workers as desired. I use one less than the number of CPU cores:
  `$ sysctl hw.ncpu`
* Set the hour and minute of periodic jobs as desired.
* Set the expire-time-span and max-cache-size values to match the values in the default.yml file.
* The local.UnityCacheServer.NightlyRestart.plist job is optional, and should only run when no Unity Editors are using it.
