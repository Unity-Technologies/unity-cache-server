#  Cache Server v6.4 [![Build Status](https://travis-ci.org/Unity-Technologies/unity-cache-server.svg?branch=master)](https://travis-ci.org/Unity-Technologies/unity-cache-server) [![Coverage Status](https://coveralls.io/repos/github/Unity-Technologies/unity-cache-server/badge.svg)](https://coveralls.io/github/Unity-Technologies/unity-cache-server)
> The Unity Cache Server, optimized for locally networked team environments.

## Overview

This repository contains an open-source implementation of the Cache Server. This stand-alone version of Cache Server is specifically optimized for LAN connected teams. The Cache Server speeds up initial import of project data, as well as platform switching within a project.

This open-source repository is maintained separately from the Cache Server available on the Unity website and the implementation of the Cache Server that is packaged with the Unity installer.

This version of the cache server does not support the new Asset Database Version 2 introduced in Unity 2019.3. For projects using the new Asset import pipeline, use the [Accelerator](https://blogs.unity3d.com/2019/09/11/speed-up-your-team-with-the-unity-accelerator/)

#### Table of Contents
* [Server Setup](#server-setup)
    * [Install from npm registry](#install-from-npm-registry)
    * [Install from GitHub source](#install-from-github-source)
* [Usage](#usage)
* [Configuration files](#configuration-files)
* [General Options](#general-options)
* [Client Configuration](#client-configuration)
* [Cache Modules](#cache-modules)
  * [cache\_fs (default)](#cache_fs-default)
  * [cache\_ram](#cache_ram)
* [Cache Cleanup](#cache-cleanup)
* [Mirroring](#mirroring)
* [High Reliability Mode](#high-reliability-mode)
  * [Background](#background)
  * [Function](#function)
  * [Configuration](#configuration)
* [Unity project Library Importer](#unity-project-library-importer)
* [Diagnostics](#diagnostics)
* [Contributors](#contributors)
* [License](#license)

## Server Setup

Download and install LTS version 12.13.x of Node.js from the [Node.JS website](https://nodejs.org/en/download/).

#### Install from npm registry

```bash
npm install unity-cache-server -g
```

For the latest beta release:
```bash
npm install unity-cache-server@beta -g
```

#### Install from GitHub source

```bash
npm install github:Unity-Technologies/unity-cache-server -g
```

Note: GitHub source install from `master` branch might be ahead of latest release version.

## Usage

>Default options are suitable for quickly starting a cache server, with a default cache location of `.cache_fs`

```bash
unity-cache-server [arguments]
```

Option                           | Description
-------------------------------- | -----------
`-V`, `--version`                | Show the version number of the Cache Server.
`-h`, `--host <address>`         | The interface on which the Cache Server listens. The default is to listen on all interfaces.
`-p`, `--port <n>`               | The port on which the Cache Server listens. The default value is 8126.
`-c`, `--cache-module [path]`    | The path to cache module. The Default path is 'cache_fs'.
`-P`, `--cache-path [path]`      | The path of the cache directory.
`-l`, `--log-level <n>`          | The level of log verbosity. Valid values are 0 (silent) through 4 (debug). The default is 3 (info).
`-w`, `--workers <n>`            | The number of worker threads to spawn. The default is 0.
`--diag-client-recorder`         | Record incoming client network stream to disk.
`-m`, `--mirror <host:port>`     | Mirror transactions to another cache server. Repeat this option for multiple mirrors.
`-W`, `--putwhitelist <host:port>`  | Only allow PUT transactions (uploads) from the specified client address. Repeat this option for multiple addresses.
`--dump-config`                  | Write the active configuration to the console.
`--save-config [path]`           | Write the active configuration to the specified file and exit. Defaults to `./default.yml`.
`-h`, `--help`                   | Show usage information.

## Configuration files

The `config/default.yml` file contains configuration values for the cache modules (see below) and other features. The config system is based on the node-config module. For additional information on how to manage environment specific config files, see the [Configuration Files](https://github.com/lorenwest/node-config/wiki/Configuration-Files) documentation on the node-config GitHub repository.

### General Options
Option                              | Default     | Description
----------------------------------- | ----------- | -----------
Global.logLevel                     |3            | Logging level; override with the --log-level CLI command
Cache.options.processor.putWhitelist|[]           | Only allow PUT transactions (uploads) from the specified array of IP addresses (string values)
Cache.options.workers               |1            | Number of worker threads; override with the --worker CLI command
Server.host                         |0.0.0.0      | The interface on which the Cache Server listens. Override with the --host CLI command
Server.port                         |8126         | The port on which the Cache Server listens. Override with the --port CLI command
Server.options.allowIPv6            |false        | Listen for client connections on both IPv4 and IPv6
#### Examples (Mac/Linux)


You can have multiple configuration files based on environment:

1) `export NODE_ENV=development`
2) `unity-cache-server --save-config config/local-development.yml`

To use a custom configuration directory:

1) `mkdir myCustomConfig`
2) `unity-cache-server --save-config myCustomConfig/default.yml`
3) `export NODE_CONFIG_DIR=myCustomConfig`
3) `unity-cache-server`


To dump the current config to the console, run the following command:

`unity-cache-server --dump-config`

## Client Configuration

The [Cache Server](https://docs.unity3d.com/Manual/CacheServer.html) section of the Unity Manual contains detailed information on connecting clients to remote Cache Servers.

## Cache Modules

Cache Server supports two caching mechanisms:

* A file system based cache.
* A fully memory (RAM) backed cache.

The file system module is the default and suitable for most applications. The RAM cache module provides optimal performance but requires a sufficient amount of physical RAM in the server system. Typically, this is two to three times size of your Project's Library folder on disk.

Configuration options for all modules are set in the `config/default.yml` file.

### cache_fs (default)

A simple, efficient file system backed cache.

#### Usage

`--cache-module cache_fs`

#### Options

Option                          | Default     | Description
------------------------------- | ----------- | -----------
cachePath                       | `.cache_fs` | The path to the cache directory.
cleanupOptions.expireTimeSpan   | `P30D`      | [ASP.NET](https://msdn.microsoft.com/en-us/library/se73z7b9(v=vs.110).aspx) or [ISO 8601](https://en.wikipedia.org/wiki/ISO_8601#Time_intervals) style timespan. Cache files that have not been accessed within this timespan are eligible for cleanup. For more information on duration syntax, see the [moment](https://momentjs.com/docs/#/durations/) library documentation.
cleanupOptions.maxCacheSize     | 0           | The maximum size, in bytes, of the cache on disk. To bring the total disk utilization under this threshold, the cleanup script considers files for removal in least recently used order. Set the value to zero (0) to disable the cleanup feature.

### Notes

* cache_fs is backwards compatible with v5.x Cache Server directories.
* Supports worker threads using the `--workers` option.
* When you run the cleanup script, the value of the `expireTimeSpan` option is used to determine which files to delete. If `maxCacheSize` is specified the script checks whether the cache exceeds the value of `maxCacheSize`. If it does, the script deletes files in least-recently-used order until the cache no longer exceed maxCacheSize.

## cache_ram

A high performance, fully in-memory LRU cache.

### Usage

`--cache-module cache_ram`

### Options

Option                              | Default      | Description
----------------------------------- | ------------ | -----------
pageSize                            | 100000000    | The page size, in bytes, used to grow the cache.
maxPageCount                        | 10           | The maximum number of pages to allocate in the cache. The combination of `pageSize` and `maxPageCount` limits the overall memory footprint of the cache. When this threshold is reached, memory is recovered using a Least Recently Used (LRU) algorithm.
minFreeBlockSize                    | 1024         | The size of the minimum allocation unit, in bytes, within a page. You can specify a lower value for smaller projects.
cachePath                           | `.cache_ram` | The path to the cache directory. Dirty memory pages are saved to disk periodically in this directory, and loaded at startup.
persistence                         | true         | Enable saving and loading of page files to disk. If `false`, the cache is emptied during restart.
persistenceOptions.autosave         | true         | When set to `true`, automatically save changed memory pages; set to `false` to disable. If `false`, pages are only saved when the cache server is stopped with the `q` console command or with upon a SIGTERM.
persistenceOptions.autosaveInterval | 10000        | The frequency, in milliseconds, to save pages that have changed.

### Notes

* Does not support worker threads.

## Cache Cleanup

Due to performance considerations, the `cache_fs` module shipped with Cache Server v6.0 does NOT operate as an LRU cache and does not enforce overall cache size restrictions. This is a change from previous versions of Cache Server. To manage disk usage, a separate cleanup script is provided that can either be run periodically or in "daemon" mode to automatically run at a given time interval.

### Usage

`unity-cache-server-cleanup [option]`
or
`node cleanup.js [options]`

Option                           | Description
-------------------------------- | -----------
-V, --version                    | Show the version number of cleanup script.
-c --cache-module [path]         | The path to the cache module.
-P, --cache-path [path]          | The path of the cache directory.
-l, --log-level <n>              | The level of log verbosity. Valid values are 0 (silent) through 4 (debug)
-e, --expire-time-span <timeSpan>| Override the configured file expiration timespan. Both ASP.NET style time spans (days.minutes:hours:seconds, for example '15.23:59:59') and ISO 8601 time spans (For example, 'P15DT23H59M59S') are supported.
-s, --max-cache-size <bytes>     | Override the configured maximum cache size. Files will be removed from the cache until the max cache size is satisfied, using a Least Recently Used search. A value of 0 disables this check.
-d, --delete                     | Delete cached files that match the configured criteria. Without this, the default behavior is to dry-run which will print diagnostic information only.
-D, --daemon <interval>          | Daemon mode. Execute the cleanup script at the given interval in seconds as a foreground process.
-h, --help                       | Show usage information.

### Notes

* Only the cache_fs module supports cache cleanup (cache_ram does not).

## Mirroring

### Usage

Use the `--mirror [host:port]` option to relay all upload transactions to one or more Cache Server hosts (repeat the option for each host).

__Important__: Use the `--mirror` option cautiously. There are checks in place to prevent self-mirroring, but it is still possible to create infinite transaction loops.

### Options

Option                | Default     | Description
--------------------- | ----------- | -----------
queueProcessDelay     | 2000        | The period, in milliseconds, to delay the start of processing the queue, from when the first transaction is added to an empty queue. Each transaction from a client is queued after completion. It's a good idea to keep this value at or above the default value to avoid possible I/O race conditions with recently completed transactions.
connectionIdleTimeout | 10000       | The period, in milliseconds, to keep connections to remote mirror hosts alive, after processing a queue of transactions. Queue processing is bursty. To minimize the overhead of connection setup and teardown, calibrate this value for your environment.

## High Reliability Mode

High Reliability Mode imposes stricter requirements on upload transactions to increase the integrity of cached data.

### Background

Asset versions are cached based on the Asset GUID and Asset hash reported by the client (Unity Editor). The Asset hash is calculated from the inputs to the Asset import process. The import process should produce the same binary result for a given set of inputs, but there is no guarantee that it will. Instability in the import process is typically an indication of a bug or design problem in the Asset importer.These errors can be propagated to other clients because Unity is not able to detect these instabilities before committing them to the Cache Server.

### Function

In the default operating mode (`highReliability` is __false__), the Cache Server accepts all transactions for all versions of an Asset from any Unity client. In this scenario, the version of an Asset can change after it is already committed and the commit can cause an incorrect or unstable import.

High Reliability Mode allows the Cache Server to compare multiple transactions for the same version for binary stability before committing a version to the cache, and disallows further modifications to already committed versions. When an instability is detected, warning messages are logged and caching of the Asset is suspended until a team member uploads a new version of the Asset.

Requiring multiple imports of the same Asset to ensure the stability of each Asset version is resource intensive. High Reliability Mode is primarily beneficial to developers in networked team environments, where the increased overhead of importing Assets multiple times is distributed across the entire team. The larger the team, the smaller the impact on any individual.


### Configuration

When _highReliability_ is __true__, a counter for an Asset version is incremented with each transaction that is binary identical to the previous. When the counter reaches the configured `reliabilityThreshold`, the version is committed to the cache and served. For networked team environments, setting `multiClient` to __true__ forces more than one client to commit the same transaction to increment the counter. Setting `reliabilityThreshold` to  a value of 0 or 1 disables the reliability checks, but still prevents versions from changing. For debugging purposes, setting `saveUnreliableVersionArtifacts` to __true__ isolates and saves all uploads of unstable Asset versions for later inspection and diffing.

Option                                               | Default      | Description
------------------------------------------           | ------------ | -----------
highReliability                                      | false        | Enable high reliability mode.
highReliabilityOptions.reliabilityThreshold          | 2            | Number of binary-stable imports of the same version required before a version is cached and served.
highReliabilityOptions.saveUnreliableVersionArtifacts| true         | After a version is declared unreliable, save all subsequent transactions for the version for later inspection and debugging.
highReliabilityOptions.multiClient                   | false        | Require multiple clients to upload the same binary-stable version to increment the stability factor. For example, if the same client uploads the same version twice in a row, it does not increase stability of the version.

## Unity project Library Importer

Tools are provided to quickly seed a Cache Server from a fully imported Unity project (a project with a Library folder).

### Steps to Import a Project

1) Add the [CacheServerTransactionImporter.cs](./Unity/CacheServerTransactionExporter.cs) script to the Unity project to export.
2) To save an export data file in .json format, in the Unity Editor, select __Cache Server Utilities__ > __Export Transactions__ . Alternatively, with the script added to your project, you can run Unity in batch mode using the `-executeMethod` option. For the `<ClassName.MethodName>`, use `CacheServerTransactionExporter.ExportTransactions([path])` where `path` is the full path and filename to export. For more information on running the Editor in silent mode and the `-executeMethod` option, see [Command line arguments](https://docs.unity3d.com/Manual/CommandLineArguments.html).
3) Run the import utility to begin the import process: `unity-cache-server-import <path to json file> [server:port]`

### Notes

* On very large projects, Unity might appear to freeze while generating the exported JSON data.
* The default `server:port` is `localhost:8126`
* The import process connects and uploads to the target host like any other Unity client, so it should be safe in a production environment.
* Files are skipped if any changes were detected between when the JSON data was exported and when the importer tool is executed.

## Diagnostics

### Client Recorder (--diag-client-recorder)

Starting up the Cache Server with the `--diag-client-recorder` option will write to disk raw data from all incoming client connections (by default to the `diagnostics/client-recordings` folder). Example tools and libraries for analysing recorded sessions can be found in the [ucs-diag-tools](https://github.com/Unity-Technologies/ucs-diag-utils) repository.

### Configuration

Option                                               | Default                         | Description
------------------------------------------           | ------------------------------- | -----------
Diagnostics.clientRecorder                           | false                           | Enable client network stream recording.
Diagnostics.clientRecorderOptions.bufferSize         | 10000000                        | Size of in-memory buffer for client network stream recording. 
Diagnostics.clientRecorderOptions.saveDir            | "diagnostics/client-recordings" | Directory where client network stream recordings will be saved. A relative directory will be relative to the server application startup directory.

## Contributors
Contributions are welcome! Before submitting pull requests please note the Submission of Contributions section of the Apache 2.0 license.

The server protocol is described in [protocol.md](./protocol.md)

## License

Apache-2.0 © [Unity Technologies](http://www.unity3d.com)
