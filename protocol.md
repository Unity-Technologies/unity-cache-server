# Server Protocol

Version and size numbers are sent back end forth in hex-encoding. Eg. the
version is sent as `000000fe` over the wire (and *not* the binary `000\u00fe`).

## Version check

```
client --- (version <uint32>) --> server	  (using version)
client <-- (version <uint32>) --- server	  (echo version if supported or 0)
```

The server reads eight bytes of data from the first package received. If the
package contain less than eight bytes, only those are used. Only exception if
getting a one-byte package, in which case it should wait for the next package
in order go get at least two bytes worth of data.

The only accepted client version is 254 (`0xfe` / `0x000000fe`), to which the
server answers `0x000000fe`. In all other cases the server replies `0x00000000`
and closes the connection.

## Request cached item
```
# Asset binaries
client --- 'ga' (id <128bit GUID><128bit HASH>) --> server
client <-- '+a' (size <uint64>) (id <128bit GUID><128bit HASH>) + size bytes --- server (found in cache)
client <-- '-a' (id <128bit GUID><128bit HASH>) --- server (not found in cache)

# Info files
client --- 'gi' (id <128bit GUID><128bit HASH>) --> server
client <-- '+i' (size <uint64>) (id <128bit GUID><128bit HASH>) + size bytes --- server (found in cache)
client <-- '-i' (id <128bit GUID><128bit HASH>) --- server (not found in cache)

# Resources
client --- 'gr' (id <128bit GUID><128bit HASH>) --> server
client <-- '+r' (size <uint64>) (id <128bit GUID><128bit HASH>) + size bytes --- server	(found in cache)
client <-- '-r' (id <128bit GUID><128bit HASH>) --- server (not found in cache)
```

Cache miss:

    grUUIDUUIDUUIDUUIDHASHHASHHASHHASH # uuid/hash is sent as 32 bytes
    -rUUIDUUIDUUIDUUIDHASHHASHHASHHASH # negative response

Cache hit:

    grUUIDUUIDUUIDUUIDHASHHASHHASHHASH
    +r00000000000000ffUUIDUUIDUUIDUUIDHASHHASHHASHHASH<255 bytes of data>

Note that the size is sent as 16 bytes encoded as hexadecimal

## Putting items

Multiple entries (asset, info and resources) exist for one item in the server,
so they're always uploaded inside a transaction:

```
client --- 'ts' (id <128bit GUID><128bit HASH>) --> server
```

Then one or more put operations for different kinds of assets

```
client --- 'pa' (size <uint64>) + size bytes --> server
client --- 'pi' (size <uint64>) + size bytes --> server
client --- 'pr' (size <uint64>) + size bytes --> server
```

And finally the whole thing is finished of (i.e. rename targets to their final names).

```
client --- 'te' --> server
```

An example transaction could be (newlines added for readability)

    ts00000000000000ff00000000000000ee # Start transaction for GUID ff / hash ee (32 bytes in total, raw binary stuff)
    pi0000000000000008                 # Put eight bytes of info
    INFOBLOB                           # Eight bytes of info
    pa0000000000000008                 # Put eight bytes of data
    DATABLOB                           # Eight bytes of data
    te                                 # End transaction

## Quit

```
client --- 'q' --> server
```

It should be noted that most clients quit by simply closing the connection.