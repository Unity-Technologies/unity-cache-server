# unity-cache-server [![Build Status](https://travis-ci.org/Unity-Technologies/unity-cache-server.svg?branch=master)](https://travis-ci.org/Unity-Technologies/unity-cache-server) [![Coverage Status](https://coveralls.io/repos/github/Unity-Technologies/unity-cache-server/badge.svg)](https://coveralls.io/github/Unity-Technologies/unity-cache-server)
> The Unity Cache Server, optimized for networked team environments.

## Overview
This is the officially maintained open-source implementation of the Unity Cache Server, specifically optimized for LAN connected teams. The Unity Cache Server speeds up initial import of project data, as well as platform switching within a project.

At present time this open-source repository is maintained separately from the Cache Server available on the Unity website, as well as the version packaged with the Unity installer. It is possible that compatibility with specific versions of Unity will diverge between these separate implementations. Check the release notes for specific compatibility information prior to usage.

#### Table of Contents
* [Server Setup](#server-setup)
    * [Install from npm registry](#install-from-npm-registry)
    * [Install from GitHub source](#install-from-github-source)
* [Usage](#usage)
* [Options](#options)
* [Configuration file](#configuration-file)
* [Client Configuration](#client-configuration)
* [Cache Modules](#cache-modules)
  * [cache\_fs (default)](#cache_fs-default)
  * [cache\_ram](#cache_ram)
* [Cache Cleanup](#cache-cleanup)
* [Mirroring](#mirroring)
* [Unity project Library Importer](#unity-project-library-importer)
* [Contributors](#contributors)
* [License](#license)

## Server Setup
Download and install the latest LTS version of node from the [Node.JS website](`https://nodejs.org/en/download/`).

#### Install from npm registry
```bash
npm install unity-cache-server -g
```
#### Install from GitHub source
```bash
npm install github:Unity-Technologies/unity-cache-server -g
```
## Usage
>Default options are suitable for quickly starting a cache server, with a default cache location of `.cache_fs`
```bash
unity-cache-server [arguments]
```

## Options
```
    -V, --version                     output the version number
    -p, --port <n>                    Specify the server port, only apply to new cache server, default is 8126
    -c --cache-module [path]          Use cache module at specified path. Default is 'cache_fs'
    -P, --cache-path [path]           Specify the path of the cache directory.
    -l, --log-level <n>               Specify the level of log verbosity. Valid values are 0 (silent) through 5 (debug). Default is 3
    -w, --workers <n>                 Number of worker threads to spawn. Default is 0
    -m --mirror [host:port]           Mirror transactions to another cache server. Can be repeated for multiple mirrors.
    -m, --monitor-parent-process <n>  Monitor a parent process and exit if it dies
    --dump-config                     Write the active configuration to the console
    --save-config [path]              Write the active configuration to the specified file and exit. Defaults to ./default.yml
    --NODE_CONFIG_DIR=<path>          Specify the directory to search for config files. This is equivalent to setting the NODE_CONFIG_DIR environment variable. Without this option, the built-in configuration is used.
    -h, --help                        output usage information
```
## Configuration files
`config/default.yml` contains various configuration values for the cache modules (see below) and other features. The config system is based on the [node-config](`https://github.com/lorenwest/node-config/wiki/Configuration-Files`) module. Refer to the documentation in that package for tips on how to manage environment specific config files.
By default, running `unity-cache-server` will use the built-in configuration file. To start using a custom config file, save the current config to a new file and then use the `--NODE_CONFIG_DIR` option to override the location where the cache server will look for your config file(s).
#### Examples (Mac/Linux)
1) `mkdir config`
2) `unity-cache-server --save-config config/default.yml`
3) `unity-cache-server --NODE_CONFIG_DIR=config`

You can also have multiple configuration files based on environment:
1) `export NODE_ENV=development`
2) `unity-cache-server --save-config config/local-development.yml`

To dump the current config to the console
`unity-cache-server --dump-config`

## Client Configuration
The [Cache Server](https://docs.unity3d.com/Manual/CacheServer.html) section of the Unity Manual contains detailed information on connecting clients to remote Cache Servers.

## Cache Modules
Two distinct caching mechanisms are provided: a simple file system based cache, and a fully memory (RAM) backed cache. The file system module is the default and suitable for most applications. The RAM cache module provides optimal performance but requires a sufficient amount of physical RAM in the server system.

Configuration options for all modules are set in the `config/default.yml` file.
### cache_fs (default)
A simple, efficient file system backed cache.
#### Usage
`--cache-module cache_fs`
#### Options
option    | default     | description
--------- | ----------- | -----------
cachePath | `.cache_fs` | Path to cache directory
cleanupOptions.expireTimeSpan | `P30D` | [ASP.NET](https://msdn.microsoft.com/en-us/library/se73z7b9(v=vs.110).aspx) or [ISO 8601](https://en.wikipedia.org/wiki/ISO_8601#Time_intervals) style timespan. Cache files that have not been accessed within this timespan will be eligible for cleanup/removal. The [moment](https://momentjs.com/docs/#/durations/) library is used to parse durations - more information on duration syntax can be found in the library documentation.
cleanupOptions.maxCacheSize | 0 | Size in bytes to limit overall cache disk utilization. The cleanup script will consider files for removal in least-recently-used order to bring the total disk utilization under this threshold. 0 disables this cleanup feature. 
#### Notes
* This module is backwards compatible with v5.x Cache Server directories
* Supports worker threads (`--workers` option)
### cache_ram
A high performance, fully in-memory LRU cache.
#### Usage
`--cache-module cache_ram`
#### Options
option    | default     | description
--------- | ----------- | -----------
pageSize | 100000000 | Smallest memory allocation to make, in bytes. i.e. the cache will grow in increments of pageSize.
maxPageCount | 10 | Maximum number of pages allowed in the cache. This combined with `pageSize` effectively limits the overall memory footprint of the cache. When this threshold is reached, an LRU mechanism will kick in to find room for new files.
minFreeBlockSize | 1024 | Smallest allocation unit within a page. Can be lowered for smaller projects.
cachePath | `.cache_ram` | Path to cache directory. Dirty memory pages are saved to disk periodically in this directory, and loaded at startup.
persistence | true | Enable saving and loading of page files to disk. If `false`, the cache will be empty at every restart.
persistenceOptions.autosave | true | `true` to periodically save dirty memory pages automatically; `false` to disable. If `false`, pages will only be saved when the cache server is stopped with the `q` console command or with SIGTERM.
persistenceOptions.autosaveInterval | 10000 | Minimum interval in milliseconds to save dirty pages.
#### Notes
* Does not support worker threads
## Cache Cleanup
For performance and simplicity reasons, unlike prior versions, the cache_fs module does NOT operate as an LRU cache and does not enforce overall cache size restrictions. To manage disk usage, a separate cleanup script is provided that can either be run periodically or in "daemon" mode to automatically run at a given time interval.
### Usage
`unity-cache-server-cleanup [option]`
or
`node cleanup.js [options]`
#### Options
```    -V, --version                      output the version number
       -c --cache-module [path]           Use cache module at specified path
       -P, --cache-path [path]            Specify the path of the cache directory
       -l, --log-level <n>                Specify the level of log verbosity. Valid values are 0 (silent) through 5 (debug)
       -e, --expire-time-span <timeSpan>  Override the configured file expiration timespan. Both ASP.NET style time spans (days.minutes:hours:seconds, e.g. '15.23:59:59') and ISO 8601 time spans (e.g. 'P15DT23H59M59S') are supported.
       -s, --max-cache-size <bytes>       Override the configured maximum cache size. Files will be removed from the cache until the max cache size is satisfied, using a Least Recently Used search. A value of 0 disables this check.
       -d, --delete                       Delete cached files that match the configured criteria. Without this, the default behavior is to dry-run which will print diagnostic information only.
       -D, --daemon <interval>            Daemon mode: execute the cleanup script at the given interval in seconds as a foreground process.
       -h, --help                         output usage information
```
#### Notes
* Only the cache_fs module supports cache cleanup (cache_ram does not)
## Mirroring
#### Usage
Use the `--mirror [host:port]` option to relay all upload transactions to one or more Cache Server hosts (repeat the option for each host). There are checks in place to prevent self-mirroring, but beyond that it would be easy to create infinite transaction loops so use with care.
#### Options
option    | default     | description
--------- | ----------- | -----------
queueProcessDelay | 2000 | Each transaction from a client is queued after completion. The `queueProcessDelay` (ms) will delay the start of processing the queue, from when the first transaction is added to an empty queue. It's a good idea to keep this value at or above the default value to avoid possible I/O race conditions with recently completed transactions.
connectionIdleTimeout | 10000 | Keep connections to remote mirror hosts alive for this length in ms, after processing a queue of transactions. Queue processing is 'bursty' so this should be calibrated to minimize the overhead of connection setup & tear-down.

## Unity project Library Importer
Tools are provided to quickly seed a Cache Server from a fully imported Unity project (a project with a Library folder).
#### Steps to Import
1) Add the [CacheServerTransactionImporter.cs](./Unity/CacheServerTransactionExporter.cs) script to the Unity project you wish to export.
2) Select the Menu item _Cache Server Utilities -> Export Transactions_ to save an export data file in .json format. Alternatively, with the script added to your project, you can run Unity in batchmode and [execute the static method](https://docs.unity3d.com/Manual/CommandLineArguments.html) `CacheServerTransactionExporter.ExportTransactions([path])` where `path` is the full path and filename to export.
3) Run the import utility to begin the import process: `unity-cache-server-import <path to json file> [server:port]`
#### Notes
* On very large projects, Unity may appear to freeze while generating the exported JSON data.
* The default `server:port` is `localhost:8126`
* The import process connects and uploads to the target host like any other Unity client, so it should be safe in a production environment.
* Files will be skipped if any changes were detected between when the JSON data was exported and when the importer tool is executed.

## Contributors
Contributions are welcome! Before submitting pull requests please note the Submission of Contributions section of the Apache 2.0 license.

The server protocol is described in [protocol.md](./protocol.md)

## License

Apache-2.0 © [Unity Technologies](http://www.unity3d.com)
