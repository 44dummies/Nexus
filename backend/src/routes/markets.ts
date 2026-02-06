import { Router } from 'express';
import { MARKET_CATALOG } from '../lib/marketCatalog';

const router = Router();

router.get('/', (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json({ markets: MARKET_CATALOG });
});

export default router;
