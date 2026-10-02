import mysql from 'mysql2/promise';

async function updateDubTypes() {
  console.log('Connecting to MySQL database...');
  const conn = await mysql.createConnection({
    host: '37.27.232.161',
    user: 'jeevanka_user',
    password: 'MyAnimePass@2026!',
    database: 'jeevanka_anime'
  });

  console.log('\n--- 1. Updating anime_series ---');
  // Tokyo Revengers
  const [res1] = await conn.query(`
    UPDATE anime_series 
    SET dub_type = 'Both', total_seasons = 3, total_episodes = 49 
    WHERE tmdb_id = 105009
  `);
  console.log('Tokyo Revengers in anime_series updated:', res1.affectedRows, 'row(s)');

  // Re:Monster
  const [res2] = await conn.query(`
    UPDATE anime_series 
    SET dub_type = 'Both', total_seasons = 1, total_episodes = 24 
    WHERE tmdb_id = 235389
  `);
  console.log('Re:Monster in anime_series updated:', res2.affectedRows, 'row(s)');

  console.log('\n--- 2. Updating dropembed_anime_series ---');
  // Tokyo Revengers
  const [res3] = await conn.query(`
    UPDATE dropembed_anime_series 
    SET dub_type = 'Both', total_seasons = 3, total_episodes = 49 
    WHERE tmdb_id = 105009
  `);
  console.log('Tokyo Revengers in dropembed_anime_series updated:', res3.affectedRows, 'row(s)');

  // Re:Monster
  const [res4] = await conn.query(`
    UPDATE dropembed_anime_series 
    SET dub_type = 'Both', total_seasons = 1, total_episodes = 24 
    WHERE tmdb_id = 235389
  `);
  console.log('Re:Monster in dropembed_anime_series updated:', res4.affectedRows, 'row(s)');

  console.log('\n--- 3. Verifying updated rows ---');
  const [verify1] = await conn.query('SELECT id, tmdb_id, title, dub_type, total_seasons, total_episodes FROM anime_series WHERE tmdb_id IN (105009, 235389)');
  console.log('anime_series:');
  console.table(verify1);

  const [verify2] = await conn.query('SELECT id, tmdb_id, title, dub_type, total_seasons, total_episodes FROM dropembed_anime_series WHERE tmdb_id IN (105009, 235389)');
  console.log('dropembed_anime_series:');
  console.table(verify2);

  await conn.end();
  console.log('\n✅ Database updates applied successfully!');
}

updateDubTypes().catch(console.error);
