# unity-cache-server
> The Unity Cache Server, with clustering (multi-process)

## Setup
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

## Server Protocol

#### version check
client --- (version <uint32>) --> server	  (using version)
client <-- (version <uint32>) --- server	  (echo version if supported or 0)

#### request cached item
client --- 'ga' (id <128bit GUID><128bit HASH>) --> server
client <-- '+a' (size <uint64>) (id <128bit GUID><128bit HASH>) + size bytes --- server (found in cache)
client <-- '-a' (id <128bit GUID><128bit HASH>) --- server (not found in cache)

client --- 'gi' (id <128bit GUID><128bit HASH>) --> server
client <-- '+i' (size <uint64>) (id <128bit GUID><128bit HASH>) + size bytes --- server (found in cache)
client <-- '-i' (id <128bit GUID><128bit HASH>) --- server (not found in cache)

client --- 'gr' (id <128bit GUID><128bit HASH>) --> server
client <-- '+r' (size <uint64>) (id <128bit GUID><128bit HASH>) + size bytes --- server	(found in cache)
client <-- '-r' (id <128bit GUID><128bit HASH>) --- server (not found in cache)

#### start transaction
client --- 'ts' (id <128bit GUID><128bit HASH>) --> server

#### put cached item
client --- 'pa' (size <uint64>) + size bytes --> server
client --- 'pi' (size <uint64>) + size bytes --> server
client --- 'pr' (size <uint64>) + size bytes --> server

#### end transaction (ie rename targets to their final names)
client --- 'te' --> server

#### cache server integrity
client --- 'ic' (<char 'v' or 'f'>) --> server
client <-- 'ic' (errors <uint64>) --- server

#### quit
client --- 'q' --> server


## License

Apache-2.0 © [Unity Technologies](http://www.unity3d.com)
