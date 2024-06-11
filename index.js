import express from 'express';
import bodyParser from 'body-parser';
import pg from 'pg';
import axios from 'axios';
import getPort from 'get-port';
import multer from 'multer';
import path from 'path';
import fs from 'fs';

import { fileURLToPath } from 'url';

// Define __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const { Client, Pool } = pg; // Import Pool for database connection pooling

// Setting up the app
const app = express();

async function findAvailablePort(startPort) {
  const portRange = Array.from({ length: 1000 }, (_, i) => startPort + i);
  const port = await getPort({ port: portRange });
  return port;
}

const port = await findAvailablePort(3000);

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json()); // Ensure the server can parse JSON request bodies
app.use('/public', express.static('public'));

// Set view engine to ejs
app.set('view engine', 'ejs');

// Connecting to the database
const clientConfig = {
  user: 'postgres',
  host: 'localhost',
  password: '$Israel111111',
  port: 5432,
};

// Multer setup for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'public/cover_images/');
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname));
  },
});
const upload = multer({ storage });

async function connectClient(config) {
  const client = new Client(config);
  try {
    await client.connect();
    return client;
  } catch (err) {
    console.error('Connection error:', err.stack);
    throw err;
  }
}

// Creating the database if it doesn't exist
async function createDatabase() {
  const client = await connectClient(clientConfig);
  try {
    // Check if the database exists
    const checkDbResult = await client.query(`
      SELECT 1 AS result
      FROM pg_database
      WHERE datname = 'librarylist';
    `);

    if (checkDbResult.rows.length === 0) {
      // Create the database if it does not exist
      await client.query(`CREATE DATABASE librarylist;`);
      console.log('Database created successfully.');
      return true;
    } else {
      console.log('Database already exists.');
      return false;
    }
  } catch (err) {
    console.error('Error creating database:', err);
  } finally {
    await client.end();
  }
}

async function createTable() {
  const librarylistConfig = { ...clientConfig, database: 'librarylist' };
  const librarylistClient = await connectClient(librarylistConfig);

  try {
    // Check if the table exists
    const checkTableResult = await librarylistClient.query(`
      SELECT to_regclass('public.user_info') AS table_name;
    `);

    if (checkTableResult.rows[0].table_name === null) {
      // Create the table if it does not exist
      await librarylistClient.query(`
        CREATE TABLE user_info (
          book_number SERIAL PRIMARY KEY,
          note TEXT
        );

        CREATE TABLE book_info (
          serial_book_id SERIAL PRIMARY KEY,
          title VARCHAR(255) NOT NULL,
          category VARCHAR(255),
          isbn VARCHAR(20),
          path_in_public_to_cover VARCHAR(255),
          description TEXT,
          author VARCHAR(255),
          date_read TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          rating INT CHECK (rating >= 1 AND rating <= 10),
          book_number INT,
          CONSTRAINT fk_book_number FOREIGN KEY (book_number) REFERENCES user_info(book_number)
        );
      `);
      console.log('Tables created successfully.');
    } else {
      console.log('Tables already exist.');
    }
  } catch (err) {
    console.error('Error creating tables:', err);
  } finally {
    await librarylistClient.end();
  }
}

(async function main() {
  try {
    const isDbCreated = await createDatabase();

    if (isDbCreated) {
      await createTable();
    } else {
      await createTable();
    }
  } catch (err) {
    console.error('Error in main execution:', err);
  }
})();

const pool = new Pool({
  ...clientConfig,
  database: 'librarylist', // Ensure the pool is connected to the 'librarylist' database
});

// Setting up the routes
// GET route for /
app.get('/', async (req, res) => {
  try {
    const booksResult = await pool.query(`
      SELECT b.serial_book_id, b.title, b.category, b.isbn, b.author, b.rating, b.description, b.path_in_public_to_cover, u.note
      FROM book_info b
      JOIN user_info u ON b.book_number = u.book_number
    `);

    const books = booksResult.rows;

    res.render('main', { books });
  } catch (error) {
    console.error('Error fetching books data:', error);
    res.status(500).send('Internal Server Error');
  }
});

app.get('/book_adder', (req, res) => {
  res.render('book_adder');
});

// GET route for displaying a particular book's notes
app.get('/:id([0-9]+)', async (req, res) => {
  const bookId = req.params.id;

  try {
    const bookResult = await pool.query(
      `SELECT b.title, b.path_in_public_to_cover, u.note
       FROM book_info b
       JOIN user_info u ON b.book_number = u.book_number
       WHERE b.serial_book_id = $1`,
      [bookId]
    );

    if (bookResult.rows.length === 0) {
      return res.status(404).send('Book not found');
    }

    const book = bookResult.rows[0];

    res.render('particular_book_notes', {
      title: book.title,
      note: book.note,
      imagePath: book.path_in_public_to_cover
    });
  } catch (error) {
    console.error('Error fetching book data:', error);
    res.status(500).send('Internal Server Error');
  }
});

async function fetchCoverImageFromOpenLibrary(isbn, bookNumber) {
  try {
    const coverResponse = await axios.get(`https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg`, {
      responseType: 'arraybuffer',
    });
    if (coverResponse.status === 200 && coverResponse.headers['content-type'].startsWith('image')) {
      const fileName = `cover_image_${bookNumber}.jpg`;
      const coverImagePath = `/public/cover_images/${fileName}`;
      fs.writeFileSync(path.join(__dirname, 'public', 'cover_images', fileName), coverResponse.data);
      return coverImagePath;
    }
  } catch (error) {
    console.log('OpenLibrary cover not found or error occurred:', error);
  }
  return null;
}

async function fetchCoverImageFromGoogleBooks(isbn, bookNumber) {
  try {
    const googleBooksResponse = await axios.get(`https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}`);
    const bookData = googleBooksResponse.data.items && googleBooksResponse.data.items[0];
    if (bookData && bookData.volumeInfo && bookData.volumeInfo.imageLinks && bookData.volumeInfo.imageLinks.thumbnail) {
      const coverUrl = bookData.volumeInfo.imageLinks.thumbnail;
      const coverImageResponse = await axios.get(coverUrl, { responseType: 'arraybuffer' });
      if (coverImageResponse.status === 200 && coverImageResponse.headers['content-type'].startsWith('image')) {
        const fileName = `cover_image_${bookNumber}.jpg`;
        const coverImagePath = `/public/cover_images/${fileName}`;
        fs.writeFileSync(path.join(__dirname, 'public', 'cover_images', fileName), coverImageResponse.data);
        return coverImagePath;
      }
    }
  } catch (error) {
    console.log('Google Books cover not found or error occurred:', error);
  }
  return null;
}

app.post('/add-book', upload.single('cover_image'), async (req, res) => {
  const { title, category, isbn, author, note, rating, description } = req.body;
  let coverImagePath = null;
  let bookDescription = description; // Use user's input for the description

  try {
    // Insert into user_info table
    const userInfoResult = await pool.query(
      'INSERT INTO user_info (note) VALUES ($1) RETURNING book_number',
      [note]
    );

    const bookNumber = userInfoResult.rows[0].book_number;

    // Check if a file was uploaded
    if (req.file) {
      coverImagePath = `/public/cover_images/${req.file.filename}`;
    } else if (isbn) {
      coverImagePath = await fetchCoverImageFromOpenLibrary(isbn, bookNumber);
      if (!coverImagePath) {
        coverImagePath = await fetchCoverImageFromGoogleBooks(isbn, bookNumber);
      }
    }

    // Insert into book_info table
    await pool.query(
      `INSERT INTO book_info (title, category, isbn, author, book_number, rating, path_in_public_to_cover, description)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [title, category, isbn, author, bookNumber, rating, coverImagePath, bookDescription]
    );

    res.redirect('/');
  } catch (error) {
    console.error('Error inserting data into database:', error);
    res.status(500).send('Internal Server Error');
  }
});


// Route to render the edit book form
app.get('/edit-book/:id([0-9]+)', async (req, res) => {
  const bookId = req.params.id;

  try {
    const bookResult = await pool.query(
      `SELECT b.serial_book_id, b.title, b.category, b.isbn, b.author, b.rating, b.description, u.note
       FROM book_info b
       JOIN user_info u ON b.book_number = u.book_number
       WHERE b.serial_book_id = $1`,
      [bookId]
    );

    if (bookResult.rows.length === 0) {
      return res.status(404).send('Book not found');
    }

    const book = bookResult.rows[0];

    res.render('book_editer', {
      book_id: book.serial_book_id,
      title: book.title,
      category: book.category,
      isbn: book.isbn,
      author: book.author,
      note: book.note,
      rating: book.rating,
      description: book.description,
    });
  } catch (error) {
    console.error('Error fetching book data:', error);
    res.status(500).send('Internal Server Error');
  }
});

// POST route to handle form submission for editing a book
app.post('/edit-book', upload.single('cover_image'), async (req, res) => {
  const { book_id, title, category, isbn, author, note, rating, description } = req.body;

  try {
    let coverImagePath = null;
    if (req.file) {
      coverImagePath = `/public/cover_images/${req.file.filename}`;
    }

    // Update user_info table
    await pool.query(
      `UPDATE user_info
       SET note = $1
       WHERE book_number = (
         SELECT book_number FROM book_info WHERE serial_book_id = $2
       )`,
      [note, book_id]
    );

    // Update book_info table
    const queryParams = [title, category, isbn, author, rating, description, book_id];
    let query = `
      UPDATE book_info
      SET title = $1, category = $2, isbn = $3, author = $4, rating = $5, description = $6
      WHERE serial_book_id = $7
    `;

    if (coverImagePath) {
      queryParams.splice(5, 0, coverImagePath); // insert coverImagePath at position 5
      query = `
        UPDATE book_info
        SET title = $1, category = $2, isbn = $3, author = $4, rating = $5, path_in_public_to_cover = $6, description = $7
        WHERE serial_book_id = $8
      `;
    }

    await pool.query(query, queryParams);

    res.redirect('/');
  } catch (error) {
    console.error('Error updating book data:', error);
    res.status(500).send('Internal Server Error');
  }
});

// DELETE route to handle book deletion
app.delete('/delete-book/:id', async (req, res) => {
  const { id } = req.params;
  console.log(`Received request to delete book with id: ${id}`); // Debugging line
  try {
    // Delete from book_info table
    await pool.query('DELETE FROM book_info WHERE serial_book_id = $1', [id]);

    // Delete from user_info table
    await pool.query('DELETE FROM user_info WHERE book_number = $1', [id]);

    res.status(200).send('Book deleted successfully');
  } catch (error) {
    console.error('Error deleting data from database:', error);
    res.status(500).send('Internal Server Error');
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
