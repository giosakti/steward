# Workspaces

Start the server using the [quick start](../README.md#getting-started), then
create and select a workspace from another terminal:

```sh
npm run steward -- workspace create personal "Personal project" --root-path .
npm run steward -- workspace use personal
npm run steward -- workspace show
npm run steward -- agent show
npm run steward -- agent configure --title "Engineering Lead"
```

Each workspace has one root agent, named and titled `Steward` by default.
`--root-path` is optional and records an existing directory; these commands do
not modify its files. Agent configuration also accepts `--name` and
`--role-description`.

The CLI uses `STEWARD_API_URL` (default `http://127.0.0.1:3000`) and
`STEWARD_API_TOKEN`; it never connects directly to PostgreSQL. Relative root paths
are resolved from the CLI working directory and must exist on the server.

`workspace use` resolves the slug through the API and saves the workspace UUID
and API address locally. The default file is `$XDG_CONFIG_HOME/steward/config.json`
or `~/.config/steward/config.json`; override it with `STEWARD_CONFIG_FILE`.
It contains no credentials. Selection applies only to the saved API address;
select again when switching servers. Missing, invalid, or stale selections fail
explicitly. Use `--workspace <slug>` for a temporary override:

```sh
npm run steward -- --workspace personal agent show
npm run steward -- workspace list
npm run steward -- --help
```

These commands authenticate as the human operator through HTTP. Creating a
workspace does not start an agent or grant it execution authority.
