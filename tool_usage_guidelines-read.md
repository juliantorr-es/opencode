# read — Multi-Purpose Reader

**Used by**: All agents

## Purpose
Read anything — artifacts, library types, coordination messages. One tool for all read operations.

## Actions
- `artifact` — Read a session artifact (plan, context, findings)
- `lib` — Read framework library type definitions
- `messages` — Read coordination messages

## Example
```
read(action="artifact", session="ses_189abc")
read(action="lib", package="effect", file="Layer.d.ts", symbol="provideMerge")
read(action="messages")
```
