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
>Default options are suitable for quickly starting a cache server, with a default cache location of `./cache5.0`
```bash
unity-cache-server [arguments]
```

## Options
```
    -V, --version                     output the version number
    -p, --port <n>                    Specify the server port, only apply to new cache server, default is 8126
    -c --cache-module [path]          Use cache module at specified path. Default is 'lib/cache/cache_fs'
    -P, --cache-path [path]           Specify the path of the cache directory.
    -l, --log-level <n>               Specify the level of log verbosity. Valid values are 0 (silent) through 5 (debug). Default is 3
    -w, --workers <n>                 Number of worker threads to spawn. Default is 0
    --statsd-server [host]            Send statsd metrics to this host
    --statsd-tags [key:val,...]       Extra tags for statsd metrics
    -m --mirror [host:port]           Mirror transactions to another cache server. Can be repeated for multiple mirrors.
    -m, --monitor-parent-process <n>  Monitor a parent process and exit if it dies
    -h, --help                        output usage information
```
## Configuration file
`config/default.yml` contains various configuration values for the cache modules (see below) and other features. The config system is based on the [node-config](`https://github.com/lorenwest/node-config/wiki/Configuration-Files`) module. Refer to the documentation in that package for tips on how to manage environment specific config files.

## Client Configuration
The [Cache Server](https://docs.unity3d.com/Manual/CacheServer.html) section of the Unity Manual contains detailed information on connecting clients to remote Cache Servers.

## Cache Modules
Two distinct caching mechanisms are provided: a simple file system based cache, and a fully memory (RAM) backed cache. The file system module is the default and suitable for most applications. The RAM cache module provides optimal performance but requires a sufficient amount of physical RAM in the server system.

Configuration options for all modules are set in the `config/default.yml` file.
### cache_fs (default)
A simple, efficient file system backed cache.
#### Usage
`--cache-module lib/cache/cache_fs`.
#### Options
option    | default     | description
--------- | ----------- | -----------
cachePath | `.cache_fs` | Path to cache directory
#### Notes
* This module is backwards compatible with v5.x Cache Server directories
* For performance and simplicity reasons, unlike prior versions, it does NOT operate as an LRU cache and does not enforce overall cache size restrictions. If disk space is a concern, external shell scripts can be executed periodically to clean up files that have not been accessed recently.
* Supports worker threads (`--workers` option)
### cache_ram
A high performance, fully in-memory LRU cache.
#### Usage
`--cache-module lib/cache/cache_ram`
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
3) Run the import utility to begin the import process: `node import.js <path to json file> [server:port]`
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
