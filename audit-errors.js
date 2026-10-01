import mysql from 'mysql2/promise';

async function auditErrors() {
  const conn = await mysql.createConnection({
    host: '37.27.232.161',
    user: 'jeevanka_user',
    password: 'MyAnimePass@2026!',
    database: 'jeevanka_anime'
  });

  const [summary] = await conn.query(`
    SELECT stream_type, COUNT(*) as count 
    FROM dropembed_anime_episodes 
    GROUP BY stream_type
  `);
  console.log('Final Summary:');
  console.table(summary);

  const [uploadErrors] = await conn.query(`
    SELECT id, anime_title, season, episode, format, qualities_json 
    FROM dropembed_anime_episodes 
    WHERE stream_type = 'UPLOAD_ERROR' 
    LIMIT 5
  `);
  console.log('\nSample UPLOAD_ERROR (transient upload failure):');
  console.table(uploadErrors);

  const [hlsErrors] = await conn.query(`
    SELECT id, anime_title, season, episode, format, qualities_json 
    FROM dropembed_anime_episodes 
    WHERE stream_type = 'HLS_ERROR' 
    LIMIT 5
  `);
  console.log('\nSample HLS_ERROR:');
  console.table(hlsErrors);

  await conn.end();
}

auditErrors().catch(console.error);
