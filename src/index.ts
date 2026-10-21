import joplin from 'api';
import { logger } from './logger';
import { registerSettings } from './settings';

joplin.plugins.register({
  onStart: async function () {
    logger.info('Incremental Backup plugin started.');
    await registerSettings();
  },
});
