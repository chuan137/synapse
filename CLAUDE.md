# Synapse Project Notes

## To-Do

- **File viewer: persist state across refresh** — when the file viewer panel is open and the user refreshes the page, the panel disappears (state is in-memory only). Consider using `sessionStorage` to record the currently open file path and restore it on page load. Low-effort improvement.
