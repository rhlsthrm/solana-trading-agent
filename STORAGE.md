# Database Storage Configuration

This document explains how to set up persistent storage for the SQLite database in this project.

## Database Path

The application uses a SQLite database file and looks for it at the following location:

- Path specified by the `DB_PATH` environment variable
- Default fallback: `/data/trading.db`

## Railway Deployment

When deploying to Railway:

1. **Add a Volume**:
   - Go to your project in Railway
   - Navigate to the "Volumes" tab
   - Add a new volume
   - Set the mount path to `/data`
   - Set an appropriate size (1-5GB is usually sufficient)

2. **Add Environment Variable**:
   - Go to the "Variables" tab
   - Add a variable `DB_PATH` with value `/data/trading.db`

3. **Deploy and Restart**:
   - Deploy your project
   - Restart all services to ensure they use the new volume

## Local Development

For local development, you can:

1. Set `DB_PATH` to a location on your machine:
   ```
   export DB_PATH=/path/to/your/local/trading.db
   ```

2. Or use the default path:
   ```
   mkdir -p /data
   touch /data/trading.db
   chmod 666 /data/trading.db
   ```

## Shared Database

All services (web, telegram-monitor, position-monitor) share the same database file. This ensures:

1. Trades are recorded once and accessible everywhere
2. Position data is consistent across all services
3. Token information is stored in one place

## Troubleshooting

If you're not seeing data in your dashboard:

1. Check that the volume is correctly mounted
2. Verify the `DB_PATH` environment variable
3. Ensure the database file exists and has the right permissions
4. Check the logs for any database connection errors