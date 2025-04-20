const { createApp, ref, computed, onMounted, watch } = Vue;

const app = createApp({
    setup() {
        const title = ref('Анализ Недвижимости в Кыргызстане');
        const rawData = ref([]);
        const filteredData = ref([]);
        const districts = ref([]);
        const propertyTypes = ref([]);
        const periods = ref([]);
        let dataTable = null;
        
        const selectedPeriod = ref('');
        const selectedDistrict = ref('');
        const selectedPropertyType = ref('');

        // Функция форматирования цены в сомах
        const formatPrice = (price) => {
            return new Intl.NumberFormat('ru-RU', {
                style: 'currency',
                currency: 'KGS',
                maximumFractionDigits: 0
            }).format(price);
        };

        // Вычисляемые свойства для статистики
        const averagePrice = computed(() => {
            if (!filteredData.value.length) return formatPrice(0);
            const avg = d3.mean(filteredData.value, d => d['Среднее (сом/кв,м,)']);
            return formatPrice(Math.round(avg));
        });

        const minPrice = computed(() => {
            if (!filteredData.value.length) return formatPrice(0);
            const min = d3.min(filteredData.value, d => d['Среднее (сом/кв,м,)']);
            return formatPrice(Math.round(min));
        });

        const maxPrice = computed(() => {
            if (!filteredData.value.length) return formatPrice(0);
            const max = d3.max(filteredData.value, d => d['Среднее (сом/кв,м,)']);
            return formatPrice(Math.round(max));
        });

        // Загрузка данных
        const loadData = async () => {
            try {
                console.log('Starting data loading process...');
                const response = await fetch('/data/march_prices.csv');
                
                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }
                
                const text = await response.text();
                console.log('CSV text loaded:', text.substring(0, 200) + '...');
                
                const parsedData = d3.dsvFormat(';').parse(text);
                console.log('Parsed data sample:', parsedData.slice(0, 2));
                
                if (parsedData.length === 0) {
                    throw new Error('No data was parsed from the CSV file');
                }
                
                rawData.value = parsedData.map(d => {
                    let price = d['Среднее (сом/кв,м,)'];
                    if (typeof price === 'string') {
                        price = price.replace(',', '.');
                    }
                    const numericPrice = parseFloat(price);
                    
                    return {
                        ...d,
                        'Среднее (сом/кв,м,)': isNaN(numericPrice) ? 0 : numericPrice
                    };
                });

                // Получаем уникальные значения для фильтров
                districts.value = [...new Set(rawData.value.map(d => d['Район']))].sort();
                propertyTypes.value = [...new Set(rawData.value.map(d => d['Вид недвижимости']))].sort();
                periods.value = [...new Set(rawData.value.map(d => d['Дата']))].sort();

                initializeDataTable();
                updateFilters();
            } catch (error) {
                console.error('Error loading data:', error);
                console.error('Error details:', {
                    message: error.message,
                    stack: error.stack
                });
            }
        };

        // Инициализация таблицы
        const initializeDataTable = () => {
            if (dataTable) {
                dataTable.destroy();
            }

            $.fn.dataTable.ext.search.push(
                function(settings, data, dataIndex) {
                    if (!selectedPeriod.value && !selectedDistrict.value && !selectedPropertyType.value) {
                        return true;
                    }
                    
                    const rowPeriod = data[0];
                    const rowDistrict = data[1];
                    const rowPropertyType = data[2];

                    const periodMatch = !selectedPeriod.value || rowPeriod === selectedPeriod.value;
                    const districtMatch = !selectedDistrict.value || rowDistrict === selectedDistrict.value;
                    const propertyTypeMatch = !selectedPropertyType.value || rowPropertyType === selectedPropertyType.value;

                    return periodMatch && districtMatch && propertyTypeMatch;
                }
            );

            dataTable = new DataTable('#dataTable', {
                data: rawData.value,
                columns: [
                    { data: 'Дата' },
                    { data: 'Район' },
                    { data: 'Вид недвижимости' },
                    { 
                        data: 'Среднее (сом/кв,м,)',
                        render: function(data, type) {
                            if (type === 'display') {
                                return formatPrice(data);
                            }
                            return data;
                        }
                    }
                ],
                language: {
                    url: '//cdn.datatables.net/plug-ins/1.11.5/i18n/ru.json'
                },
                order: [[0, 'desc']],
                pageLength: 10,
                responsive: true,
                dom: 'lrtip',
                footerCallback: function(row, data, start, end, display) {
                    const api = this.api();

                    // Удаляем форматирование для вычисления суммы
                    const priceTotal = api
                        .column(3, { search: 'applied' })
                        .data()
                        .reduce((acc, val) => acc + parseFloat(val), 0);

                    const priceAvg = priceTotal / api.column(3, { search: 'applied' }).data().length;

                    // Обновляем футер
                    $(api.column(3).footer()).html(formatPrice(priceAvg));
                    $(api.column(0).footer()).html('<strong>Среднее значение:</strong>');
                },
                initComplete: function() {
                    // Добавляем свой поиск
                    const api = this.api();
                    $('#dataTable_filter input')
                        .off()
                        .on('input', function() {
                            api.search(this.value).draw();
                        });
                }
            });
        };

        // Обновление фильтрованных данных
        const updateFilters = () => {
            filteredData.value = rawData.value.filter(d => {
                const periodMatch = !selectedPeriod.value || d['Дата'] === selectedPeriod.value;
                const districtMatch = !selectedDistrict.value || d['Район'] === selectedDistrict.value;
                const typeMatch = !selectedPropertyType.value || d['Вид недвижимости'] === selectedPropertyType.value;
                return periodMatch && districtMatch && typeMatch;
            });

            if (dataTable) {
                dataTable.draw(); // Просто перерисовываем таблицу с текущими фильтрами
            }

            updateCharts();
        };

        // Обновление графиков
        const updateCharts = () => {
            updateTimeChart();
            updatePropertyTypeChart();
        };

        // График динамики цен по периодам
        const updateTimeChart = () => {
            d3.select('#timeChart').html('');

            const margin = { top: 20, right: 30, bottom: 100, left: 100 };
            const width = document.getElementById('timeChart').clientWidth - margin.left - margin.right;
            const height = document.getElementById('timeChart').clientHeight - margin.top - margin.bottom;

            const svg = d3.select('#timeChart')
                .append('svg')
                .attr('width', width + margin.left + margin.right)
                .attr('height', height + margin.top + margin.bottom)
                .append('g')
                .attr('transform', `translate(${margin.left},${margin.top})`);

            // Группируем данные по периоду
            const groupedData = d3.group(filteredData.value, d => d['Дата']);
            const averagedData = Array.from(groupedData, ([date, values]) => ({
                date,
                price: d3.mean(values, d => d['Среднее (сом/кв,м,)'])
            })).sort((a, b) => periods.value.indexOf(a.date) - periods.value.indexOf(b.date));

            // Создаем шкалы
            const x = d3.scaleBand()
                .domain(periods.value)
                .range([0, width])
                .padding(0.1);

            const y = d3.scaleLinear()
                .domain([0, d3.max(averagedData, d => d.price)])
                .range([height, 0]);

            // Добавляем оси
            svg.append('g')
                .attr('transform', `translate(0,${height})`)
                .call(d3.axisBottom(x))
                .selectAll('text')
                .attr('transform', 'rotate(-45)')
                .style('text-anchor', 'end')
                .attr('dx', '-0.8em')
                .attr('dy', '0.15em');

            svg.append('g')
                .call(d3.axisLeft(y).tickFormat(d => formatPrice(d)))
                .selectAll('text')
                .attr('dx', '-0.5em');

            // Создаем линию
            const line = d3.line()
                .x(d => x(d.date) + x.bandwidth() / 2)
                .y(d => y(d.price));

            // Добавляем линию на график
            svg.append('path')
                .datum(averagedData)
                .attr('class', 'line')
                .attr('fill', 'none')
                .attr('stroke', '#2c3e50')
                .attr('stroke-width', 2)
                .attr('d', line);

            // Добавляем точки
            svg.selectAll('.dot')
                .data(averagedData)
                .enter()
                .append('circle')
                .attr('class', 'dot')
                .attr('cx', d => x(d.date) + x.bandwidth() / 2)
                .attr('cy', d => y(d.price))
                .attr('r', 4)
                .style('fill', '#2c3e50');

            // Добавляем подписи осей
            svg.append('text')
                .attr('class', 'axis-label')
                .attr('text-anchor', 'middle')
                .attr('x', width / 2)
                .attr('y', height + margin.bottom - 10)
                .text('Период');

            svg.append('text')
                .attr('class', 'axis-label')
                .attr('text-anchor', 'middle')
                .attr('transform', 'rotate(-90)')
                .attr('y', -margin.left + 30)
                .attr('x', -height / 2)
                .text('Цена за м² (сом)');
        };

        // График цен по типам недвижимости
        const updatePropertyTypeChart = () => {
            d3.select('#propertyTypeChart').html('');

            const margin = { top: 20, right: 30, bottom: 100, left: 100 };
            const width = document.getElementById('propertyTypeChart').clientWidth - margin.left - margin.right;
            const height = document.getElementById('propertyTypeChart').clientHeight - margin.top - margin.bottom;

            const svg = d3.select('#propertyTypeChart')
                .append('svg')
                .attr('width', width + margin.left + margin.right)
                .attr('height', height + margin.top + margin.bottom)
                .append('g')
                .attr('transform', `translate(${margin.left},${margin.top})`);

            // Создаем tooltip
            const tooltip = d3.select('#propertyTypeChart')
                .append('div')
                .attr('class', 'tooltip')
                .style('opacity', 0)
                .style('position', 'absolute')
                .style('background-color', 'rgba(0, 0, 0, 0.8)')
                .style('color', 'white')
                .style('padding', '8px')
                .style('border-radius', '4px')
                .style('font-size', '12px')
                .style('pointer-events', 'none');

            // Группируем данные по типу недвижимости
            const groupedData = d3.group(filteredData.value, d => d['Вид недвижимости']);
            const averagedData = Array.from(groupedData, ([type, values]) => ({
                type,
                price: d3.mean(values, d => d['Среднее (сом/кв,м,)']),
                count: values.length
            })).sort((a, b) => b.price - a.price);

            // Создаем шкалы
            const x = d3.scaleBand()
                .domain(averagedData.map(d => d.type))
                .range([0, width])
                .padding(0.1);

            const y = d3.scaleLinear()
                .domain([0, d3.max(averagedData, d => d.price)])
                .range([height, 0]);

            // Добавляем оси
            svg.append('g')
                .attr('transform', `translate(0,${height})`)
                .call(d3.axisBottom(x))
                .selectAll('text')
                .attr('transform', 'rotate(-45)')
                .style('text-anchor', 'end')
                .attr('dx', '-0.8em')
                .attr('dy', '0.15em');

            svg.append('g')
                .call(d3.axisLeft(y).tickFormat(d => formatPrice(d)))
                .selectAll('text')
                .attr('dx', '-0.5em');

            // Добавляем столбцы
            svg.selectAll('.bar')
                .data(averagedData)
                .enter()
                .append('rect')
                .attr('class', 'bar')
                .attr('x', d => x(d.type))
                .attr('y', d => y(d.price))
                .attr('width', x.bandwidth())
                .attr('height', d => height - y(d.price))
                .attr('fill', '#3498db')
                .on('mouseover', function(event, d) {
                    d3.select(this)
                        .transition()
                        .duration(200)
                        .attr('fill', '#2980b9');
                    
                    tooltip.transition()
                        .duration(200)
                        .style('opacity', .9);
                    
                    tooltip.html(`
                        <strong>${d.type}</strong><br/>
                        Средняя цена: ${formatPrice(d.price)}<br/>
                        Количество объектов: ${d.count}
                    `)
                        .style('left', (event.pageX + 10) + 'px')
                        .style('top', (event.pageY - 28) + 'px');
                })
                .on('mouseout', function() {
                    d3.select(this)
                        .transition()
                        .duration(500)
                        .attr('fill', '#3498db');
                    
                    tooltip.transition()
                        .duration(500)
                        .style('opacity', 0);
                });

            // Добавляем подписи осей
            svg.append('text')
                .attr('class', 'axis-label')
                .attr('text-anchor', 'middle')
                .attr('x', width / 2)
                .attr('y', height + margin.bottom - 10)
                .text('Тип недвижимости');

            svg.append('text')
                .attr('class', 'axis-label')
                .attr('text-anchor', 'middle')
                .attr('transform', 'rotate(-90)')
                .attr('y', -margin.left + 30)
                .attr('x', -height / 2)
                .text('Цена за м² (сом)');
        };

        // Инициализация
        onMounted(() => {
            loadData();
        });

        // Следим за изменениями фильтров
        watch([selectedPeriod, selectedDistrict, selectedPropertyType], () => {
            updateFilters();
        });

        return {
            title,
            selectedPeriod,
            selectedDistrict,
            selectedPropertyType,
            districts,
            propertyTypes,
            periods,
            averagePrice,
            minPrice,
            maxPrice,
            updateFilters
        };
    }
});

app.mount('#app'); 