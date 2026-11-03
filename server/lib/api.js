import axios from 'axios';
import { getLogger } from '../logger.js';

export async function fetchPaginated(baseUrl, opts = {}) {
  const log = getLogger();
  const {
    limitParam = 'limit',
    skipParam = 'skip',
    limitValue = 100,
    itemsKey = 'items',
    headers = {},
  } = opts;
  const allItems = [];
  let skip = 0;

  while (true) {
    const separator = baseUrl.includes('?') ? '&' : '?';
    const url = `${baseUrl}${separator}${limitParam}=${limitValue}&${skipParam}=${skip}`;
    log.debug({ url }, 'Paginated request');
    const response = await axios.get(url, { headers });
    const items = response.data[itemsKey] || [];
    allItems.push(...items);
    skip += limitValue;

    log.debug({ fetched: items.length, total: allItems.length, skip }, 'Pagination progress');

    if (items.length < limitValue) break;
  }

  return allItems;
}
