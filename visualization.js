document.addEventListener('DOMContentLoaded', () => {
    // 변수 선언
    const TOPO_URL = "./merged_map.json";
    const MIGRATION_DATA_URL = "./migration_sigungu.csv";
    const sigunguObjectKey = '법정구역_시군구_simplified';
    const MAX_PARTICLES = 5000;
    const MIN_MIGRATION_COUNT = 100;
    let migrationPaths = new Map();
    let migrationData, geojsonSigungu, currentYear;
    let particles = [], lastTime = 0, animationFrameId;
    let canvasTransform = d3.zoomIdentity;
    const regionDataByCode = new Map();
    let selectedSigunguCode = null;

    const svg = d3.select("#map-svg");
    const canvas = d3.select("#particle-canvas");
    const ctx = canvas.node().getContext("2d");
    const mapGroup = svg.append("g");
    const path = d3.geoPath().projection(d3.geoMercator());
    
    const zoom = d3.zoom().scaleExtent([0.5, 50]).on("zoom", (event) => {
        mapGroup.attr("transform", event.transform);
        canvasTransform = event.transform;
        const k = event.transform.k;
        const zoomThreshold = 3.5;
        mapGroup.selectAll(".province-label").style("opacity", k <= zoomThreshold ? 1 : 0);
        mapGroup.selectAll(".region-label").style("opacity", k > zoomThreshold ? 1 : 0);
    });
    svg.call(zoom);

    function drawAll() {
        const rect = d3.select("#map-container").node().getBoundingClientRect();
        const { width, height } = rect;
        const dpr = window.devicePixelRatio || 1;
        canvas.attr("width", width * dpr).attr("height", height * dpr).style("width", `${width}px`).style("height", `${height}px`);
        ctx.scale(dpr, dpr);
        svg.attr("viewBox", `0 0 ${width} ${height}`);
        path.projection().fitSize([width, height], geojsonSigungu);
        mapGroup.selectAll(".municipality").attr("d", path);
        mapGroup.selectAll(".province-label").attr("transform", d => `translate(${path.centroid(d.geometry)})`);
        mapGroup.selectAll(".region-label").attr("transform", d => `translate(${path.centroid(d)})`);

        regionDataByCode.clear();
        geojsonSigungu.features.forEach(feature => {
            if (feature?.properties) {
                const code = feature.properties.SIG_CD;
                const name = feature.properties.SIG_KOR_NM;
                if (code && name) {
                    const [cx, cy] = path.centroid(feature);
                    regionDataByCode.set(code, { code: code, name: name, projX: cx, projY: cy });
                }
            }
        });
        if(currentYear) updateParticles(currentYear);
    }

    Promise.all([
        d3.json(TOPO_URL),
        d3.csv(MIGRATION_DATA_URL)
    ]).then(([topoData, migData]) => {
        migrationData = migData;
        geojsonSigungu = topojson.feature(topoData, topoData.objects[sigunguObjectKey]);

        mapGroup.selectAll(".municipality")
            .data(geojsonSigungu.features)
            .enter().append("path")
            .attr("class", "municipality")
            .on("click", function(event, d) {
                const clickedCode = d.properties.SIG_CD;
                selectedSigunguCode = (selectedSigunguCode === clickedCode) ? null : clickedCode;
                mapGroup.selectAll(".municipality").classed("selected", p => p.properties.SIG_CD === selectedSigunguCode);
                updateParticles(currentYear);
            });
        
        mapGroup.selectAll(".region-label")
            .data(geojsonSigungu.features)
            .enter().append("text")
            .attr("class", "label region-label")
            .text(d => d.properties.SIG_KOR_NM);

        const sigunguGeometries = topoData.objects[sigunguObjectKey].geometries;
        const geometriesByProvince = d3.group(sigunguGeometries, (d, i) => geojsonSigungu.features[i].properties.CTP_KOR_NM);
        const provinceLabelData = Array.from(geometriesByProvince, ([key, value]) => ({
            name: key,
            geometry: topojson.merge(topoData, value)
        }));
        mapGroup.selectAll(".province-label")
            .data(provinceLabelData)
            .enter().append("text")
            .attr("class", "label province-label")
            .text(d => d.name);

        document.getElementById('loading').style.display = 'none';
        document.getElementById('controls').style.display = 'block';

        const yearSlider = document.getElementById('yearSlider');
        currentYear = yearSlider.value;
        drawAll();
        svg.call(zoom.transform, d3.zoomIdentity);
        yearSlider.addEventListener('input', (e) => {
            currentYear = e.target.value;
            updateParticles(currentYear);
        });
        
        document.getElementById('inflow-checkbox').addEventListener('change', () => updateParticles(currentYear));
        document.getElementById('outflow-checkbox').addEventListener('change', () => updateParticles(currentYear));
        
        window.addEventListener('resize', () => {
            svg.call(zoom.transform, d3.zoomIdentity);
            drawAll();
        });

    }).catch(error => {
        console.error("데이터 로딩 또는 처리 오류:", error);
        const loadingEl = document.getElementById('loading');
        loadingEl.style.color = 'red';
        loadingEl.innerHTML = `오류 발생!<br/>- F12를 눌러 콘솔의 오류 메시지를 확인하세요.`;
    });

    function updateParticles(year) {
        document.getElementById('yearDisplay').textContent = year;
        particles = [];
        migrationPaths.clear();

        let yearData = migrationData.filter(d => d.Year == year && +d.NetMigration >= MIN_MIGRATION_COUNT);

        const showInflow = document.getElementById('inflow-checkbox').checked;
        const showOutflow = document.getElementById('outflow-checkbox').checked;

        let dataToProcess = [];
        if (selectedSigunguCode) {
            if (showInflow) {
                const inflowData = yearData.filter(d => String(d.ArrivalCode).trim() === selectedSigunguCode);
                inflowData.forEach(d => dataToProcess.push({ ...d, type: 'inflow' }));
            }
            if (showOutflow) {
                const outflowData = yearData.filter(d => String(d.DepartureCode).trim() === selectedSigunguCode);
                outflowData.forEach(d => dataToProcess.push({ ...d, type: 'outflow' }));
            }
        } else {
            yearData.forEach(d => dataToProcess.push({ ...d, type: 'normal' }));
        }

        const totalMigration = d3.sum(dataToProcess, d => +d.NetMigration);

        if (totalMigration <= 0) {
            if (animationFrameId) cancelAnimationFrame(animationFrameId);
            ctx.clearRect(0, 0, canvas.node().width, canvas.node().height);
            return;
        }

        dataToProcess.forEach(d => {
            const from = regionDataByCode.get(String(d.DepartureCode).trim());
            const to = regionDataByCode.get(String(d.ArrivalCode).trim());
            if (!from || !to) return;

            const pathKey = `${from.code}-${to.code}`;
            if (!migrationPaths.has(pathKey)) {
                const dx = to.projX - from.projX, dy = to.projY - from.projY;
                const distance = Math.sqrt(dx * dx + dy * dy);
                if (distance < 1) return;
                const midpointX = from.projX + dx * 0.5, midpointY = from.projY + dy * 0.5;
                const perpendicularX = dy / distance, perpendicularY = -dx / distance;
                const curveOffset = distance * 0.1;
                const controlX = midpointX + perpendicularX * curveOffset;
                const controlY = midpointY + perpendicularY * curveOffset;
                migrationPaths.set(pathKey, { start: from, end: to, controlX, controlY, totalCount: 0, type: d.type });
            }
            migrationPaths.get(pathKey).totalCount += +d.NetMigration;
        });

        migrationPaths.forEach(path => {
            const numParticles = Math.ceil((path.totalCount / totalMigration) * MAX_PARTICLES);
            for (let i = 0; i < numParticles; i++) {
                particles.push(createParticle(path, path.type));
            }
        });

        if (animationFrameId) cancelAnimationFrame(animationFrameId);
        lastTime = 0;
        animationFrameId = requestAnimationFrame(animationLoop);
    }
    
    function createParticle(path, type) {
        const p = {
            path: path,
            type: type, //inflow, outflow, normal 
            reset: function() {
                this.progress = 0;
                const dx = this.path.end.projX - this.path.start.projX;
                const dy = this.path.end.projY - this.path.start.projY;
                const distance = Math.sqrt(dx * dx + dy * dy);
                if (distance < 1) { this.duration = Infinity; return; }
                this.duration = 7000 + Math.random() * 3000;
                this.size = 0.9 + Math.random() * 1;
            },
            update: function(deltaTime) {
                if (this.duration === Infinity) return;
                this.progress += deltaTime / this.duration;
                if (this.progress >= 1) { this.reset(); return; }
                const t = this.progress, t2 = t * t, mt = 1 - t, mt2 = mt * mt;
                this.x = this.path.start.projX * mt2 + this.path.controlX * 2 * mt * t + this.path.end.projX * t2;
                this.y = this.path.start.projY * mt2 + this.path.controlY * 2 * mt * t + this.path.end.projY * t2;
            }
        };
        p.reset();
        p.progress = Math.random();
        return p;
    }

    function animationLoop(currentTime) {
        if (!lastTime) lastTime = currentTime;
        const deltaTime = currentTime - lastTime;
        lastTime = currentTime;
        const dpr = window.devicePixelRatio || 1;
        const width = canvas.node().width / dpr;
        const height = canvas.node().height / dpr;
        ctx.clearRect(0, 0, width * dpr, height * dpr);

        particles.forEach(p => p.update(deltaTime));

        ctx.save();
        ctx.translate(canvasTransform.x, canvasTransform.y);
        ctx.scale(canvasTransform.k, canvasTransform.k);
        
// ... 이전 코드 ...

        ctx.strokeStyle = "rgba(255, 234, 0, 0.07)";
        ctx.lineWidth = 0.5 / Math.log(canvasTransform.k * 3); // 라인 두께를 줌 스케일로 나눔
        ctx.beginPath();
        migrationPaths.forEach(path => {
            ctx.moveTo(path.start.projX, path.start.projY);
            ctx.quadraticCurveTo(path.controlX, path.controlY, path.end.projX, path.end.projY);
        });
        ctx.stroke();

        const normalColor = 'rgba(255, 255, 150, 0.7)';
        const inflowColor = 'rgba(102, 255, 102, 0.7)';
        const outflowColor = 'rgba(255, 102, 102, 0.7)';

        const particleRadius = p => (p.size * 0.5) / Math.log(canvasTransform.k * 3); // 파티클 크기를 줌 스케일로 나눔

        ctx.fillStyle = normalColor;
        ctx.beginPath();
        particles.filter(p => p.type === 'normal' && p.progress > 0).forEach(p => {
            ctx.moveTo(p.x, p.y);
            ctx.arc(p.x, p.y, particleRadius(p), 0, Math.PI * 2);
        });
        ctx.fill();

        ctx.fillStyle = inflowColor;
        ctx.beginPath();
        particles.filter(p => p.type === 'inflow' && p.progress > 0).forEach(p => {
            ctx.moveTo(p.x, p.y);
            ctx.arc(p.x, p.y, particleRadius(p), 0, Math.PI * 2);
        });
        ctx.fill();

        ctx.fillStyle = outflowColor;
        ctx.beginPath();
        particles.filter(p => p.type === 'outflow' && p.progress > 0).forEach(p => {
            ctx.moveTo(p.x, p.y);
            ctx.arc(p.x, p.y, particleRadius(p), 0, Math.PI * 2);
        });
        ctx.fill();

        // ... 이후 코드 ...

        ctx.restore();
        animationFrameId = requestAnimationFrame(animationLoop);
    }
});
