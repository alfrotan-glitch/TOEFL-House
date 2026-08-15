# Final Clean Startup Fix

The release candidate had a real lifecycle bug: `app.listen()` was started without awaiting its `error` event, while bootstrap continued and readiness was announced even when the port was already occupied.

This clean release now bootstraps first, awaits successful listener binding, fails deterministically on `EADDRINUSE`, and only announces readiness after both bootstrap and the HTTP listener succeed. Windows launchers also refuse to start a duplicate listener and report the owning PID.
