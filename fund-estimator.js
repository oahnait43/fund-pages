(function () {
    const STORAGE_KEY = 'fund_estimation_v1';
    const SUPPORTED_CODES = new Set([
        '021532', '011035', '017192', '008705', '002910', '012447', '110023',
        '005609', '000251', '009265', '001856', '007099', '012920', '025209'
    ]);
    const UNSUPPORTED_TYPES = new Map([
        ['007099', '债券基金缺少可用的股票持仓估算'],
        ['012920', '跨境持仓涉及隔夜行情与汇率，暂不估算']
    ]);

    function clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
    }

    function finiteNumber(value) {
        if (value === null || value === undefined || value === '') return null;
        const number = Number(value);
        return Number.isFinite(number) ? number : null;
    }

    function loadState() {
        try {
            const value = JSON.parse(localStorage.getItem(STORAGE_KEY));
            return value && typeof value === 'object' ? value : {};
        } catch (error) {
            console.warn('Estimate history is invalid:', error);
            return {};
        }
    }

    function saveState(state) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    }

    function getFundState(state, code) {
        if (!state[code]) {
            state[code] = {
                official: null,
                predictions: {},
                calibration: { beta: 1, bias: 0, samples: 0, mae: null, directionHits: 0 },
                lastCheck: null
            };
        }
        return state[code];
    }

    function settleOfficialNav(fundState, officialNav, officialDate) {
        if (!Number.isFinite(officialNav) || !officialDate) return;
        const previous = fundState.official;
        if (previous?.date === officialDate) return;

        const prediction = fundState.predictions[officialDate];
        if (previous && prediction && previous.date < officialDate && previous.nav > 0) {
            const actualChange = (officialNav / previous.nav - 1) * 100;
            const error = actualChange - prediction.estimatedChange;
            const calibration = fundState.calibration;
            calibration.samples += 1;
            calibration.mae = calibration.mae === null
                ? Math.abs(error)
                : calibration.mae * 0.8 + Math.abs(error) * 0.2;
            if (Math.sign(actualChange) === Math.sign(prediction.estimatedChange)) {
                calibration.directionHits += 1;
            }
            calibration.bias = clamp(calibration.bias + clamp(error, -2, 2) * 0.15, -0.8, 0.8);
            if (Math.abs(prediction.rawChange) >= 0.15) {
                const targetBeta = clamp((actualChange - calibration.bias) / prediction.rawChange, 0.35, 1.65);
                calibration.beta = clamp(calibration.beta * 0.85 + targetBeta * 0.15, 0.35, 1.65);
            }
            fundState.lastCheck = {
                date: officialDate,
                predicted: prediction.estimatedChange,
                actual: actualChange,
                error
            };
        }

        fundState.official = { date: officialDate, nav: officialNav };
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - 45);
        const cutoffDate = cutoff.toISOString().slice(0, 10);
        for (const date of Object.keys(fundState.predictions)) {
            if (date < cutoffDate) delete fundState.predictions[date];
        }
    }

    function shanghaiDate(timestamp) {
        const date = timestamp ? new Date(timestamp * 1000) : new Date();
        return new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
        }).format(date);
    }

    function confidenceLabel(coverage, holdingsDate, calibration) {
        const ageDays = Math.max(0, (Date.now() - new Date(`${holdingsDate}T00:00:00+08:00`)) / 86400000);
        if (coverage >= 55 && ageDays <= 100 && calibration.samples >= 5 && (calibration.mae ?? 2) <= 0.8) return '较高';
        if (coverage >= 40 && ageDays <= 130 && (calibration.mae ?? 0) <= 1.2) return '中等';
        return '较低';
    }

    async function estimate(missingFunds, officialDataByCode) {
        const state = loadState();
        for (const [code, official] of officialDataByCode) {
            if (!SUPPORTED_CODES.has(code)) continue;
            settleOfficialNav(
                getFundState(state, code),
                finiteNumber(official.dwjz),
                official.jzrq
            );
        }

        const eligibleCodes = missingFunds
            .map(fund => fund.code)
            .filter(code => SUPPORTED_CODES.has(code) && !UNSUPPORTED_TYPES.has(code));
        if (eligibleCodes.length === 0) {
            saveState(state);
            return { estimates: new Map(), unsupported: UNSUPPORTED_TYPES, failed: new Map() };
        }

        const response = await fetch(`/api/holding-estimates?codes=${eligibleCodes.join(',')}`, {
            cache: 'no-store'
        });
        if (!response.ok) throw new Error(`持仓估算接口 HTTP ${response.status}`);
        const payload = await response.json();
        const estimates = new Map();
        const failed = new Map((payload.errors || []).map(item => [item.code, '持仓数据暂时不可用']));

        for (const fund of payload.funds || []) {
            const fundState = getFundState(state, fund.code);
            let weightedChange = 0;
            let coverage = 0;
            let latestTimestamp = null;
            for (const holding of fund.holdings || []) {
                const change = finiteNumber(holding.quote?.change);
                const weight = finiteNumber(holding.weight);
                if (change === null || weight === null) continue;
                weightedChange += weight * change / 100;
                coverage += weight;
                latestTimestamp = Math.max(latestTimestamp || 0, Number(holding.quote?.timestamp) || 0) || null;
            }
            if (coverage < 20 || !fundState.official?.nav) {
                failed.set(fund.code, coverage < 20 ? '有效持仓覆盖不足，暂不估算' : '缺少正式净值基准');
                continue;
            }

            const calibration = fundState.calibration;
            const estimatedChange = clamp(
                weightedChange * calibration.beta + calibration.bias,
                -10,
                10
            );
            const estimateDate = shanghaiDate(latestTimestamp);
            const today = shanghaiDate();
            if (estimateDate !== today) {
                failed.set(fund.code, '证券行情不是当日数据，暂不估算');
                continue;
            }

            fundState.predictions[estimateDate] = {
                rawChange: weightedChange,
                estimatedChange,
                officialBaseNav: fundState.official.nav,
                holdingsDate: fund.holdingsDate,
                coverage,
                savedAt: new Date().toISOString()
            };
            estimates.set(fund.code, {
                nav: fundState.official.nav * (1 + estimatedChange / 100),
                change: estimatedChange,
                rawChange: weightedChange,
                coverage,
                holdingsDate: fund.holdingsDate,
                estimateTime: latestTimestamp ? new Date(latestTimestamp * 1000).toISOString() : null,
                confidence: confidenceLabel(coverage, fund.holdingsDate, calibration),
                calibration: { ...calibration },
                lastCheck: fundState.lastCheck
            });
        }

        saveState(state);
        return { estimates, unsupported: UNSUPPORTED_TYPES, failed };
    }

    window.FundEstimator = { estimate, supportedCodes: SUPPORTED_CODES };
})();
