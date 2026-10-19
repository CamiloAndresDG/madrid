// Arranca la web con la base de datos de demostración (data/demo.db).
process.env.DB_PATH ||= require('node:path').join(__dirname, '..', 'data', 'demo.db');
require('../src/server').listen(process.env.PORT || 3000, () => console.log('Demo en http://localhost:3000 (contraseña: cambiame)'));
