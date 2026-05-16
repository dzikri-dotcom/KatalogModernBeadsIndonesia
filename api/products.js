const fs = require('fs');
const path = require('path');

function parseCsvLine(line) {
    const values = [];
    let current = '';
    let insideQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const char = line[i];

        if (char === '"') {
            if (insideQuotes && line[i + 1] === '"') {
                current += '"';
                i++;
            } else {
                insideQuotes = !insideQuotes;
            }

            continue;
        }

        if (char === ',' && !insideQuotes) {
            values.push(current.trim());
            current = '';
            continue;
        }

        current += char;
    }

    values.push(current.trim());

    return values;
}

function normalizeCategoryFromFile(fileName) {
    const rawName = fileName
        .replace('.csv', '')
        .replace('shopee_', '')
        .replace(/_/g, ' ')
        .toLowerCase();

    if (rawName.includes('diamond akrilik')) {
        return 'Diamond Akrilik';
    }

    if (rawName.includes('kristal ceko')) {
        return 'Kristal Ceko';
    }

    if (rawName.includes('manik kelopak bunga')) {
        return 'Manik Kelopak Bunga';
    }

    if (rawName.includes('berlian cangkang')) {
        return 'Berlian Cangkang';
    }

    if (rawName.includes('mutiara jepang')) {
        return 'Mutiara Jepang';
    }

    return rawName
        .split(' ')
        .filter(Boolean)
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
}

function getWhatsappNumberByCategory(category) {
    const numbers = {
        'Diamond Akrilik': '6282141932384',
        'Kristal Ceko': '6281249779960',
        'Manik Kelopak Bunga': '6281266426445',
        'Berlian Cangkang': '6282143638682',
        'Mutiara Jepang': '6285708466400'
    };

    return numbers[category] || '6282141932384';
}

function formatPriceFromCsv(price) {
    if (!price) {
        return 'Harga cek via WhatsApp';
    }

    const clean = String(price).trim();

    if (clean.toLowerCase().includes('rp')) {
        return clean;
    }

    return `Rp ${clean}`;
}

function getProductsFromCsvFiles() {
    const dataDir = path.join(process.cwd(), 'data');

    if (!fs.existsSync(dataDir)) {
        return [];
    }

    const files = fs
        .readdirSync(dataDir)
        .filter(file => file.toLowerCase().endsWith('.csv'));

    const products = [];

    files.forEach(file => {
        const filePath = path.join(dataDir, file);
        const category = normalizeCategoryFromFile(file);
        const whatsappNumber = getWhatsappNumberByCategory(category);

        let content = fs.readFileSync(filePath, 'utf8');
        content = content.replace(/^\uFEFF/, '');

        const lines = content
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(line => line.length > 0);

        if (lines.length < 2) {
            return;
        }

        const headers = parseCsvLine(lines[0]);

        for (let i = 1; i < lines.length; i++) {
            const row = parseCsvLine(lines[i]);
            const rowObject = {};

            headers.forEach((header, index) => {
                rowObject[header] = row[index] || '';
            });

            const productName =
                rowObject['whitespace-normal'] ||
                rowObject['nama_produk'] ||
                rowObject['nama produk'] ||
                rowObject['name'] ||
                rowObject['title'] ||
                row[2] ||
                'Produk';

            const price =
                rowObject['font-medium 2'] ||
                rowObject['harga'] ||
                rowObject['price'] ||
                row[3] ||
                '';

            const image =
                rowObject['_image_yazkc_11 src'] ||
                rowObject['image'] ||
                rowObject['image_url'] ||
                rowObject['gambar'] ||
                row[1] ||
                '';

            const productLink =
                rowObject['contents href'] ||
                rowObject['link'] ||
                rowObject['url'] ||
                row[0] ||
                '';

            const rating =
                rowObject['inline-block'] ||
                rowObject['rating'] ||
                row[4] ||
                '';

            const sold =
                rowObject['truncate'] ||
                rowObject['terjual'] ||
                rowObject['sold'] ||
                row[5] ||
                '';

            const whatsappText = encodeURIComponent(
                `Halo admin, saya ingin bertanya tentang produk ${productName} kategori ${category}`
            );

            products.push({
                id: `${file}-${i}`,
                sourceFile: file,
                name: productName,
                category: category,
                price: formatPriceFromCsv(price),
                rawPrice: price,
                image: image,
                link: productLink,
                rating: rating,
                sold: sold,
                whatsappNumber: whatsappNumber,
                whatsappUrl: `https://wa.me/${whatsappNumber}?text=${whatsappText}`
            });
        }
    });

    return products;
}

module.exports = function handler(req, res) {
    try {
        const products = getProductsFromCsvFiles();

        const categories = [
            ...new Set(products.map(product => product.category))
        ];

        res.status(200).json({
            success: true,
            totalProducts: products.length,
            totalCategories: categories.length,
            categories: categories,
            products: products
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message,
            totalProducts: 0,
            totalCategories: 0,
            categories: [],
            products: []
        });
    }
};