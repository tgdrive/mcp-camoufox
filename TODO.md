# TODO

- [ ] Add opt-in persistent browser profiles backed by a mounted data volume.
  - Preserve cookies and login state across service/container restarts.
  - Keep temporary isolated sessions as the default.
  - Define explicit profile selection, ownership, locking, and cleanup rules;
    never open the same profile concurrently or delete it implicitly.
  - Test restart persistence and isolation using local fixtures.
