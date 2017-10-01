# unity-cache-server [![Build Status](https://travis-ci.org/Unity-Technologies/unity-cache-server.svg?branch=master)](https://travis-ci.org/Unity-Technologies/unity-cache-server) [![Coverage Status](https://coveralls.io/repos/github/Unity-Technologies/unity-cache-server/badge.svg)](https://coveralls.io/github/Unity-Technologies/unity-cache-server)
> The Unity Cache Server, optimized for networked team environments.

## Overview
This is the officially maintained open-source implementation of the Unity Cache Server, specifically optimized for LAN connected teams. The Unity Cache Server speeds up initial import of project data, as well as platform switching within a project.

At present time this open-source repository is maintained separately from the Cache Server available on the Unity website, as well as the version packaged with the Unity installer. It is possible that compatibility with specific versions of Unity will diverge between these separate implementations. Check the release notes for specific compatibility information prior to usage.

## Server Setup
Download and install the latest LTS version of node from the [Node.JS website](https://nodejs.org/en/download/).

```bash
git clone git@github.com:Unity-Technologies/unity-cache-server.git
cd unity-cache-server
npm install
```
## Usage
>Default options are suitable for quickly starting a cache server, with a default cache location of `./cache5.0`
```bash
node main.js
```

## Options
```
    -V, --version                     output the version number
    -s, --size <n>                    Specify the maximum allowed size of the LRU cache. Files that have not been used recently will automatically be discarded when the cache size is exceeded. Default is 50Gb
    -p, --port <n>                    Specify the server port, only apply to new cache server, default is 8126
    -P, --path [path]                 Specify the path of the cache directory. Default is ./cache5.0
    -l, --log-level <n>               Specify the level of log verbosity. Valid values are 0 (silent) through 5 (debug). Default is 4 (test)
    -w, --workers <n>                 Number of worker threads to spawn. Default is 1 for every 2 CPUs reported by the OS
    -v, --verify                      Verify the Cache Server integrity, without fixing errors
    -f, --fix                         Fix errors found while verifying the Cache Server integrity
    -m, --monitor-parent-process <n>  Monitor a parent process and exit if it dies
    -h, --help                        output usage information
```

## Client Configuration
The [Cache Server](https://docs.unity3d.com/Manual/CacheServer.html) section of the Unity Manual contains detailed information on connecting clients to remote Cache Servers.

## Contributors

Contributions are welcome! Before submitting pull requests please note the Submission of Contributions section of the Apache 2.0 license.

The server protocol is described in [protocol.md](./protocol.md)

## License

Apache-2.0 © [Unity Technologies](http://www.unity3d.com)
