# Server Protocol

## Version check
```
client --- (version <uint32>) --> server	  (using version)
client <-- (version <uint32>) --- server	  (echo version if supported or 0)
```
## Request cached item
```
client --- 'ga' (id <128bit GUID><128bit HASH>) --> server
client <-- '+a' (size <uint64>) (id <128bit GUID><128bit HASH>) + size bytes --- server (found in cache)
client <-- '-a' (id <128bit GUID><128bit HASH>) --- server (not found in cache)

client --- 'gi' (id <128bit GUID><128bit HASH>) --> server
client <-- '+i' (size <uint64>) (id <128bit GUID><128bit HASH>) + size bytes --- server (found in cache)
client <-- '-i' (id <128bit GUID><128bit HASH>) --- server (not found in cache)

client --- 'gr' (id <128bit GUID><128bit HASH>) --> server
client <-- '+r' (size <uint64>) (id <128bit GUID><128bit HASH>) + size bytes --- server	(found in cache)
client <-- '-r' (id <128bit GUID><128bit HASH>) --- server (not found in cache)
```
## Start transaction
```
client --- 'ts' (id <128bit GUID><128bit HASH>) --> server
```

## Put cached item
```
client --- 'pa' (size <uint64>) + size bytes --> server
client --- 'pi' (size <uint64>) + size bytes --> server
client --- 'pr' (size <uint64>) + size bytes --> server
```

## End transaction (i.e. rename targets to their final names)
```
client --- 'te' --> server
```
## Quit
```
client --- 'q' --> server
```