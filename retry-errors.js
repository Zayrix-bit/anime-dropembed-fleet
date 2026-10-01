import mysql from 'mysql2/promise';

async function retry() {
  const conn = await mysql.createConnection({
    host: '37.27.232.161',
    user: 'jeevanka_user',
    password: 'MyAnimePass@2026!',
    database: 'jeevanka_anime'
  });

  const [res] = await conn.query(`
    UPDATE dropembed_anime_episodes 
    SET stream_type = 'HLS' 
    WHERE stream_type IN ('UPLOAD_ERROR', 'HLS_ERROR')
  `);
  console.log(`Reset ${res.affectedRows} episodes to HLS for sweep!`);

  const [counts] = await conn.query(`
    SELECT stream_type, COUNT(*) as c 
    FROM dropembed_anime_episodes 
    GROUP BY stream_type
  `);
  console.table(counts);

  await conn.end();
}

retry().catch(console.error);
