// Substitua o require('dotenv').config(); por isso:
if (process.env.NODE_ENV !== 'production') {
    require('dotenv').config(); 
}

const express = require('express');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcrypt');
const { createClient } = require('@supabase/supabase-js');

// O restante do código continua exatamente igual...

const app = express();
app.use(cors());
app.use(express.json());

// Conexão com o Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseAnonKey);

// Servir arquivos do frontend de forma estática
app.use(express.static(path.join(__dirname, '../frontend')));

// Middleware para extrair o RM enviado pelo Front
function extrairRM(req, res, next) {
    const authHeader = req.headers['authorization'];
    if (authHeader) {
        req.aluno_rm = authHeader.split(' ')[1];
    }
    next();
}
app.use(extrairRM);

// ==========================================
// ROTAS DA API
// ==========================================

// 1. Rota de Cadastro de Aluno (Para o registrar.html)
app.post('/api/auth/registrar', async (req, res) => {
    const { rm, nome, email, senha, turma_id } = req.body;
    try {
        // Criptografa a senha antes de salvar
        const senha_hash = await bcrypt.hash(senha, 10);

        const { data, error } = await supabase
            .from('alunos')
            .insert([{ rm, nome, email, senha_hash, turma_id }]);

        if (error) throw error;
        res.json({ success: true, message: 'Aluno cadastrado com sucesso!' });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

// 2. Perfil do Aluno
app.get('/api/aluno/perfil', async (req, res) => {
    const rm = req.aluno_rm;
    if (!rm) return res.status(401).json({ success: false, message: 'Não autenticado' });

    try {
        const { data, error } = await supabase
            .from('alunos')
            .select('rm, nome, email, turmas(nome, unidade_escolar)')
            .eq('rm', rm)
            .single();

        if (error) throw error;
        
        // Formata para o seu front receber estruturado
        res.json({
            success: true,
            aluno: {
                nome: data.nome,
                unidade_escolar: data.turmas?.unidade_escolar || 'Não informada',
                turma: data.turmas?.nome || 'Sem Turma'
            }
        });
    } catch (error) {
        res.status(404).json({ success: false, error: 'Aluno não encontrado' });
    }
});

// 3. Meta da Escola (Soma de todos os minutos lidos)
app.get('/api/leitura/total-escola', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('historico_leitura')
            .select('minutos_lidos');

        if (error) throw error;

        const totalMinutosEscola = data.reduce((sum, item) => sum + item.minutos_lidos, 0);
        const metaEscola = 1000000;
        const porcentagem = ((totalMinutosEscola / metaEscola) * 100).toFixed(1);

        res.json({
            success: true,
            meta: metaEscola,
            totalMinutos: totalMinutosEscola,
            porcentagem: parseFloat(porcentagem)
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 4. Progresso Individual e Histórico (Gráfico)
app.get('/api/leitura/progresso-individual', async (req, res) => {
    const rm = req.aluno_rm;
    try {
        const { data, error } = await supabase
            .from('historico_leitura')
            .select('minutos_lidos, data_registro')
            .eq('aluno_rm', rm)
            .order('data_registro', { ascending: true });

        if (error) throw error;

        const totalHistorico = data.reduce((sum, item) => sum + item.minutos_lidos, 0);

        res.json({
            success: true,
            totalHistorico: totalHistorico,
            ofensiva: 5, // Pode ser calculado baseado nos dias consecutivos depois
            historicoSemanal: data
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 5. Ranking das Turmas (Agrupado e ordenado)
app.get('/api/leitura/ranking-turmas', async (req, res) => {
    try {
        // Puxa as leituras trazendo o nome da turma vinculada ao aluno
        const { data, error } = await supabase
            .from('historico_leitura')
            .select('minutos_lidos, alunos(turmas(nome))');

        if (error) throw error;

        const agrupadoPorTurma = {};
        data.forEach(item => {
            const nomeTurma = item.alunos?.turmas?.nome || 'Outros';
            agrupadoPorTurma[nomeTurma] = (agrupadoPorTurma[nomeTurma] || 0) + item.minutos_lidos;
        });

        const ranking = Object.keys(agrupadoPorTurma).map(turma => ({
            turma: turma,
            total_minutos: agrupadoPorTurma[turma]
        })).sort((a, b) => b.total_minutos - a.total_minutos);

        res.json({ success: true, ranking });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 6. Rota de Login (Para o login.html)
app.post('/api/auth/login', async (req, res) => {
    const { rm, senha } = req.body;
    try {
        // Busca o aluno pelo RM no Supabase
        const { data: aluno, error } = await supabase
            .from('alunos')
            .select('*')
            .eq('rm', rm)
            .single();

        if (error || !aluno) {
            return res.status(400).json({ success: false, message: 'RM ou senha incorretos!' });
        }

        // Compara a senha digitada com o hash salvo no banco
        const senhaValida = await bcrypt.compare(senha, aluno.senha_hash);
        if (!senhaValida) {
            return res.status(400).json({ success: false, message: 'RM ou senha incorretos!' });
        }

        // Login bem-sucedido! Retorna o RM para o frontend salvar
        res.json({ 
            success: true, 
            message: 'Login realizado com sucesso!',
            aluno: { rm: aluno.rm, nome: aluno.nome }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 7. Rota para Registrar Minutos Lidos (Para o registrar.html)
app.post('/api/leitura/registrar', async (req, res) => {
    const { minutos } = req.body;
    const rm = req.aluno_rm; // Pega o RM de quem está logado automaticamente

    if (!rm) return res.status(401).json({ success: false, message: 'Não autenticado' });
    if (!minutos || minutos <= 0) return res.status(400).json({ success: false, message: 'Quantidade de minutos inválida' });

    try {
        const { data, error } = await supabase
            .from('historico_leitura')
            .insert([{ aluno_rm: rm, minutos_lidos: minutos }]);

        if (error) throw error;

        res.json({ success: true, message: 'Minutos registrados com sucesso!' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Servir arquivos do frontend de forma estática (garantindo o caminho absoluto)
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// Rota padrão para entregar o HTML principal caso acessem rotas indefinidas
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor ativo na porta ${PORT}`));

module.exports = app;