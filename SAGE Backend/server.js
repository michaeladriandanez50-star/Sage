const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt'); 
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
require('dotenv').config();
const db = require('./db');
const createUploadRouter = require('./uploadRoutes');
const multer = require('multer'); 
// 1. First, create the 'app'
const app = express(); 

// 2. THEN, use the middlewares
app.use(cors());
app.use(express.json()); 

// 3. Configure multer
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 2 * 1024 * 1024 } 
});

// --- EMAIL TRANSPORTER SETUP ---
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

// Basic Test Route
app.get('/', (req, res) => {
    res.send('SAGE Backend is running!');
});

// --- AUTHENTICATION ROUTES ---

// Sign Up Endpoint
app.post('/api/signup', async (req, res) => {
    try {
        const { full_name, email, department, password } = req.body;

        if (!full_name || !email || !department || !password) {
            return res.status(400).json({ error: 'All fields are required.' });
        }

        if (!email.endsWith('@tup.edu.ph')) {
            return res.status(400).json({ error: 'Only @tup.edu.ph emails are allowed.' });
        }

        const saltRounds = 10;
        const password_hash = await bcrypt.hash(password, saltRounds);

        const query = `
            INSERT INTO users (full_name, email, department, password_hash)
            VALUES (?, ?, ?, ?)
        `;
        
        const [result] = await db.execute(query, [full_name, email, department, password_hash]);

        res.status(201).json({ 
            message: 'Department Head registered successfully!',
            userId: result.insertId 
        });

    } catch (error) {
        console.error('Sign Up Error:', error);
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: 'This email is already registered.' });
        }
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// Login Endpoint
app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required.' });
        }

        const [users] = await db.execute('SELECT * FROM users WHERE email = ?', [email]);
        
        if (users.length === 0) {
            return res.status(401).json({ error: 'Invalid email or password.' });
        }

        const user = users[0];
        const isPasswordValid = await bcrypt.compare(password, user.password_hash);
        
        if (!isPasswordValid) {
            return res.status(401).json({ error: 'Invalid email or password.' });
        }

        const token = jwt.sign(
            { userId: user.user_id, department: user.department },
            process.env.JWT_SECRET,
            { expiresIn: '8h' }
        );

        res.status(200).json({
            message: 'Login successful',
            token: token,
            user: {
                full_name: user.full_name,
                email: user.email,
                department: user.department,
                profile_picture: user.profile_picture
            }
        });

    } catch (error) {
        console.error('Login Error:', error);
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// --- 2FA OTP ROUTES ---

app.post('/api/send-otp', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ error: 'Email is required.' });

        const otp_code = Math.floor(100000 + Math.random() * 900000).toString();
        const expires_at = new Date(Date.now() + 10 * 60000); 

        const query = `INSERT INTO email_otp (email, otp_code, expires_at) VALUES (?, ?, ?)`;
        await db.execute(query, [email, otp_code, expires_at]);

        const mailOptions = {
            from: `"SAGE System" <${process.env.EMAIL_USER}>`,
            to: email,
            subject: 'SAGE - Your Security Verification Code',
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 500px; margin: auto; border: 1px solid #ddd; padding: 20px; border-radius: 10px;">
                    <h2 style="color: #d4163c; text-align: center;">Security Verification</h2>
                    <p>Hello,</p>
                    <p>You are trying to log in to the SAGE system. Please use the following 6-digit code to complete your verification:</p>
                    <h1 style="text-align: center; letter-spacing: 5px; color: #1a1630;">${otp_code}</h1>
                    <p style="color: #7a6f9a; font-size: 0.9em; text-align: center;">This code will expire in 10 minutes.</p>
                </div>
            `
        };

        await transporter.sendMail(mailOptions);
        res.status(200).json({ message: 'OTP sent successfully!' });

    } catch (error) {
        console.error('DETAILED SEND OTP ERROR:', error);
        res.status(500).json({ error: error.message || 'Failed to send OTP email.' });
    }
});

app.post('/api/verify-otp', async (req, res) => {
    try {
        const { email, otp_code } = req.body;

        const [rows] = await db.execute(
            `SELECT * FROM email_otp WHERE email = ? AND is_used = FALSE ORDER BY created_at DESC LIMIT 1`, 
            [email]
        );

        if (rows.length === 0) {
            return res.status(400).json({ error: 'No active OTP found. Please request a new one.' });
        }

        const otpRecord = rows[0];

        if (otpRecord.otp_code !== otp_code) {
            return res.status(401).json({ error: 'Incorrect verification code.' });
        }

        if (new Date() > new Date(otpRecord.expires_at)) {
            return res.status(401).json({ error: 'This code has expired. Please request a new one.' });
        }

        await db.execute(`UPDATE email_otp SET is_used = TRUE WHERE otp_id = ?`, [otpRecord.otp_id]);

        res.status(200).json({ message: '2FA Verification successful!' });

    } catch (error) {
        console.error('Verify OTP Error:', error);
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// --- FORGOT PASSWORD ENDPOINT ---
app.post('/api/forgot-password', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ error: 'Email is required' });

        const [users] = await db.execute('SELECT * FROM users WHERE email = ?', [email]);
        if (users.length === 0) {
            return res.status(404).json({ error: 'Email not registered in the system.' });
        }

        const user = users[0];

        const resetToken = jwt.sign(
            { userId: user.user_id }, 
            process.env.JWT_SECRET, 
            { expiresIn: '15m' }
        );

        const resetLink = `http://localhost:3000/reset-password?token=${resetToken}`;

        const mailOptions = {
            from: `"SAGE System" <${process.env.EMAIL_USER}>`,
            to: email,
            subject: 'SAGE - Password Reset Request',
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 500px; margin: auto; border: 1px solid #ddd; padding: 20px; border-radius: 10px;">
                    <h2 style="color: #d4163c; text-align: center;">Reset Your Password</h2>
                    <p>Hello,</p>
                    <p>We received a request to reset the password for your SAGE account. Click the button below to set a new password:</p>
                    <div style="text-align: center; margin: 30px 0;">
                        <a href="${resetLink}" style="background-color: #d4163c; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: bold;">Reset Password</a>
                    </div>
                    <p style="color: #7a6f9a; font-size: 0.9em; text-align: center;">This link will expire in 15 minutes.</p>
                    <p style="color: #7a6f9a; font-size: 0.8em; text-align: center;">If you didn't request this, you can safely ignore this email.</p>
                </div>
            `
        };

        await transporter.sendMail(mailOptions);
        res.status(200).json({ message: 'Reset link sent successfully.' });

    } catch (error) {
        console.error('Forgot Password Error:', error);
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// --- ACTUAL RESET PASSWORD ENDPOINT ---
app.post('/api/reset-password', async (req, res) => {
    try {
        const { token, newPassword } = req.body;
        if (!token || !newPassword) return res.status(400).json({ error: 'Token and new password are required' });

        let decoded;
        try {
            decoded = jwt.verify(token, process.env.JWT_SECRET);
        } catch (err) {
            return res.status(401).json({ error: 'Invalid or expired token. Please request a new link.' });
        }

        const userId = decoded.userId;
        const saltRounds = 10;
        const hashedPassword = await bcrypt.hash(newPassword, saltRounds);

        await db.execute('UPDATE users SET password_hash = ? WHERE user_id = ?', [hashedPassword, userId]);

        res.status(200).json({ message: 'Password updated successfully' });

    } catch (error) {
        console.error('Reset Password Error:', error);
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// --- BULK UPLOAD ENDPOINT ---
app.use('/api/upload', createUploadRouter(db));

// --- FETCH DATA ENDPOINT ---
app.get('/api/data/:type', async (req, res) => {
    const type = req.params.type;
    let query = '';

    switch (type) {
        case 'faculty':
            query = 'SELECT faculty_id AS id, name AS description FROM faculty';
            break;
        case 'rooms':
            query = 'SELECT room_id AS id, CONCAT(room_type, " (Cap: ", capacity, ")") AS description FROM rooms';
            break;
        case 'sections':
            query = 'SELECT section_id AS id, CONCAT(program, " - Year ", year_level) AS description FROM sections';
            break;
        case 'courses':
            query = 'SELECT course_code AS id, description FROM courses';
            break;
        case 'timeslots':
            query = `
                SELECT timeslot_id AS id, 
                CONCAT(day, " ", start_time, "-", end_time) AS description, 
                modality_rule AS extra 
                FROM timeslots
                ORDER BY FIELD(day, 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'), timeslot_id ASC
            `;
            break;
        default:
            return res.status(400).json({ error: 'Invalid data type.' });
    }

    try {
        const [rows] = await db.execute(query);
        res.status(200).json(rows);
    } catch (error) {
        console.error('Fetch Data Error:', error);
        res.status(500).json({ error: 'Failed to fetch data from database.' });
    }
});

// --- DELETE DATA ENDPOINT ---
app.delete('/api/data/:type/:id', async (req, res) => {
    const { type, id } = req.params;
    let query = '';

    switch (type) {
        case 'faculty':
            query = 'DELETE FROM faculty WHERE faculty_id = ?';
            break;
        case 'rooms':
            query = 'DELETE FROM rooms WHERE room_id = ?';
            break;
        case 'sections':
            query = 'DELETE FROM sections WHERE section_id = ?';
            break;
        case 'courses':
            query = 'DELETE FROM courses WHERE course_code = ?';
            break;
        case 'timeslots':
            query = 'DELETE FROM timeslots WHERE timeslot_id = ?';
            break;
        default:
            return res.status(400).json({ error: 'Invalid data type.' });
    }

    try {
        const [result] = await db.execute(query, [id]);
        
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Record not found in the database.' });
        }
        
        res.status(200).json({ message: 'Record deleted successfully.' });
    } catch (error) {
        console.error('Delete Error:', error);
        res.status(500).json({ error: 'Failed to delete record. It might be linked to other data.' });
    }
});

// --- UPDATE DATA ENDPOINT ---
app.put('/api/data/:type/:id', async (req, res) => {
    const { type, id } = req.params;
    const { description } = req.body;
    let query = '';

    switch (type) {
        case 'faculty':
            query = 'UPDATE faculty SET name = ? WHERE faculty_id = ?';
            break;
        case 'rooms':
            query = 'UPDATE rooms SET room_type = ? WHERE room_id = ?';
            break;
        case 'sections':
            query = 'UPDATE sections SET program = ? WHERE section_id = ?';
            break;
        case 'courses':
            query = 'UPDATE courses SET description = ? WHERE course_code = ?';
            break;
        case 'timeslots':
            query = 'UPDATE timeslots SET day = ? WHERE timeslot_id = ?';
            break;
        default:
            return res.status(400).json({ error: 'Invalid data type.' });
    }

    try {
        const [result] = await db.execute(query, [description, id]);
        
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Record not found in the database.' });
        }
        
        res.status(200).json({ message: 'Record updated successfully.' });
    } catch (error) {
        console.error('Update Error:', error);
        res.status(500).json({ error: 'Failed to update record in the database.' });
    }
});




/*--- UPLOAD PROFILE PHOTO ENDPOINT (BASE64) ---*/
app.post('/api/user/upload-photo', (req, res) => {
  upload.single('profile_image')(req, res, async function (err) {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        // FIX 1: Removed the line break inside the string
        return res.status(400).json({ error: 'File size is too large. Maximum allowed size is 2MB.' });
      }
      return res.status(400).json({ error: err.message });
    } else if (err) {
      return res.status(500).json({ error: 'An error occurred during file upload.' });
    }
    
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No image file uploaded.' });
      }
      
      const { email } = req.body;
      if (!email) {
        return res.status(400).json({ error: 'User email is required.' });
      }
      
      // I-convert ang buffer patungong Base64 string
      const b64 = Buffer.from(req.file.buffer).toString('base64');
      const mimeType = req.file.mimetype; // e.g., 'image/jpeg' o 'image/png'
      
      // FIX 2: Corrected the template literal syntax using ${}
      const base64Image = `data:${mimeType};base64,${b64}`;
      
      // I-update ang database
      const query = `UPDATE users SET profile_picture = ? WHERE email = ?`;
      await db.execute(query, [base64Image, email]);
      
      res.status(200).json({
        message: 'Profile photo uploaded successfully!',
        profile_picture: base64Image
      });
    } catch (error) {
      console.error('Upload Photo Error:', error);
      res.status(500).json({ error: 'Failed to save profile photo to database.' });
    }
  });
});




// Start Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});