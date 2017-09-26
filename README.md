# Fast-CacheServer
> The is an open-source version of the Unity Cache Server

## Setup
Download and install the latest LTS version of node from the [Node.JS website](https://nodejs.org/en/download/).

```bash
git clone git@github.com:Unity-Technologies/Fast-CacheServer.git
cd Fast-CacheServer
npm install
```
## Usage
>Default options are suitable for quickly starting a cache server, with a default cache location of `./cache5.0`
```bash
node main.js
```

## Options
```bash
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
## License

MIT © [Unity Technologies](http://www.unity3d.com)
